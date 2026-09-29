# Existing QA capture implementation

This is the browser capture implementation from [Replay QA's setup guide at commit
013b15f77ec8ba5b57046f66472c36b50b9eac9f](https://github.com/replayio/loop-qa/blob/013b15f77ec8ba5b57046f66472c36b50b9eac9f/src/guidance/user-session/setup.md).
The excerpt below is unchanged. It includes the actual network, interaction, identity,
metrics, and session-context producers; it is not a new capture specification.

For Self Healing, use the [setup skill](./SKILL.md#install-the-existing-capture-implementation)
for the server forwarding route and the transport/completion differences. Do not call
QA's integration endpoint or obtain a QA registration token yourself.

---

FullStory session capture is ready to install. First use the Subtext setup wizard to create or
select the FullStory organization that will hold these sessions:

```bash
npx @subtextdev/subtext-wizard
```

Install the FullStory browser SDK and initialize it with the org id supplied by the wizard:

```bash
npm install @fullstory/browser
```

Install this capture shim before rendering the application. It records complete, bounded fetch
request/response data, uploads only new entries in retryable batches through your
same-origin Replay QA proxy, and also replays startup GET/HEAD responses through FullStory's observer
without making a second backend request. It also counts trusted clicks, completed value changes, and
Enter/Escape key actions so the User Sessions page can show activity without asking Subtext to inspect
the session. Auxiliary interactions also retain all trusted keydown/keyup events, exact input/change
values, and pasted clipboard text:

The session coordinator below is shared by every auxiliary producer. Keep each request's session
object from request start through response completion. Read the SDK's current session before each
new event; a FullStory session can change without a page reload. Do not independently cache a session
URL in individual producers.

```ts
import { FullStory, init } from '@fullstory/browser'
const CAPTURED_SESSION_INTERACTION_EVENTS = ['click', 'change', 'input', 'paste', 'keydown', 'keyup'] as const
function countsAsSessionInteraction(event: Event): boolean {
  return event.type === 'click' || event.type === 'change' ||
    (event instanceof KeyboardEvent && event.type === 'keydown' && ['Enter', 'Escape'].includes(event.key))
}

type CapturedExchange = {
  id: string
  captured_at: number
  source_timestamp: number
  method: string
  url: string
  status: number
  request_headers: Record<string, string>
  request_body: string | null
  response_headers: Record<string, string>
  response_body: string | null
  startup_body?: ArrayBuffer
  status_text?: string
}

type CapturedInteraction = {
  id: string
  captured_at: number
  source_timestamp: number
  kind: 'click' | 'change' | 'input' | 'paste' | 'keydown' | 'keyup'
  selector: string | null
  label: string | null
  tag_name?: string
  value?: string
  text?: string
  key?: string
  code?: string
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  repeat?: boolean
  isComposing?: boolean
  inputType?: string
}

const MAX_BODY_BYTES = 1_000_000
const MAX_CAPTURE_BYTES = 8_000_000
const MAX_CAPTURED_INTERACTIONS = 5_000
const ACTIONABLE_SELECTOR =
  'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [role="option"], [role="radio"], [role="switch"], [role="tab"], [contenteditable="true"]'
let setCapturedUserEmail: ((email: string) => void) | null = null
// True only once initFullStory() has actually invoked the SDK's init(). Calling any FullStory API
// before that throws ("FullStory is not loaded…"), so identifyFullStoryUser must gate on this rather
// than on org-id config alone: preview/branch/local deploys inherit VITE_FULLSTORY_ORG_ID from the
// production build but never call initFullStory (it is limited to the production origin), so a
// config-only guard would call the uninitialized SDK on login and crash the whole signed-in app.
let fullStoryInitialized = false

function configuredFullStoryOrgId(): string | undefined {
  return '<FULLSTORY_ORG_ID>' // Replace with the organization ID supplied by the wizard.
}

export interface FullStoryUser {
  id: string
  name: string
  email: string | null
}

/** Identify the authenticated user in FullStory and attach their email to Replay QA's session record. */
export function identifyFullStoryUser(user: FullStoryUser | null): void {
  if (!fullStoryInitialized || !user) return
  FullStory('setIdentity', {
    uid: user.id,
    properties: {
      displayName: user.name,
      ...(user.email ? { email: user.email } : {}),
    },
  })
  if (user.email) setCapturedUserEmail?.(user.email)
}

export function shouldStopSessionUploads(status: number): boolean {
  return status < 200 || status >= 300
}

export function initFullStory(): void {
  // DOGFOOD CONTRACT: this is Replay QA's installed copy of the capture shim documented in
  // src/guidance/user-session/setup.md. Keep both implementations aligned when auxiliary capture changes.
  const orgId = configuredFullStoryOrgId()
  if (!orgId) return

  const nativeFetch = window.fetch.bind(window)
  const pageId = crypto.randomUUID()
  let userEmail: string | null = null
  let fullStoryReady = false
  let syntheticExchange: CapturedExchange | null = null

  // All auxiliary producers use this same session object, including work finishing after rollover.
  function createCaptureSession(sessionUrl: string | null, previousSessionUrl: string | null) {
    return {
      sessionUrl, previousSessionUrl,
      capturedExchanges: [] as CapturedExchange[],
      capturedInteractions: [] as CapturedInteraction[],
      capturedBytes: 0, interactionCount: 0,
      queuedExchangeCount: 0, queuedInteractionCount: -1, queuedCapturedInteractionCount: 0,
      uploadsStopped: false, userEmail, queuedUserEmail: null as string | null,
      uploadTimer: null as ReturnType<typeof setTimeout> | null,
      uploadChain: Promise.resolve(),
      droppedNetworkCount: 0, droppedInteractionCount: 0, queuedContext: '',
    }
  }
  type CaptureSession = ReturnType<typeof createCaptureSession>
  let currentSession = createCaptureSession(null, null)

  function synchronizeSession(sessionUrl: string): CaptureSession {
    if (currentSession.sessionUrl !== sessionUrl) {
      if (currentSession.sessionUrl === null) {
        // Requests made before SDK readiness belong to the first session, even if still in flight.
        currentSession.sessionUrl = sessionUrl
      } else {
        const previous = currentSession
        if (previous.uploadTimer) clearTimeout(previous.uploadTimer)
        previous.uploadTimer = null
        void queueCaptureUpload(previous)
        currentSession = createCaptureSession(sessionUrl, previous.sessionUrl)
      }
      uploadCapture(currentSession)
    }
    return currentSession
  }

  function captureSession(): CaptureSession | null {
    if (!fullStoryReady) return currentSession
    // Read at the event boundary: an idle tab can resume into a new FullStory session without reload.
    try {
      const sessionUrl = FullStory('getSession', { format: 'url' })
      return sessionUrl ? synchronizeSession(sessionUrl) : null
    } catch {
      // Stopped/unavailable recording must not assign new events to a stale session.
      return null
    }
  }

  setCapturedUserEmail = email => {
    userEmail = email
    const session = captureSession()
    if (!session) return
    session.userEmail = email
    uploadCapture(session)
  }

  async function boundedBody(value: Request | Response): Promise<string | null> {
    const bytes = await value.clone().arrayBuffer()
    if (bytes.byteLength > MAX_BODY_BYTES) return null
    return new TextDecoder().decode(bytes)
  }

  async function sendCaptureBatch(body: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await nativeFetch('/api/replay-qa-session', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        })
        if (response.status < 500 || attempt === 2) return response
      } catch (error) {
        if (attempt === 2) throw error
      }
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt))
    }
  }

  function queueCaptureUpload(session: CaptureSession): Promise<void> {
    if (!session.sessionUrl || session.uploadsStopped) return Promise.resolve()
    const exchanges = session.capturedExchanges.slice(session.queuedExchangeCount)
      .map(({ startup_body: _body, status_text: _status, ...exchange }) => exchange)
      .sort((a, b) => a.source_timestamp - b.source_timestamp)
    const context = JSON.stringify({
      id: pageId,
      page_started_at: performance.timeOrigin,
      previous_session_url: session.previousSessionUrl,
      dropped_network_count: session.droppedNetworkCount,
      dropped_interaction_count: session.droppedInteractionCount,
    })
    const auxiliaryData = [
      ...(context !== session.queuedContext ? [{
        namespace: 'session', key: 'capture-context', schema_version: 1,
        payload: { version: 1, pages: [{
          id: pageId, page_started_at: performance.timeOrigin,
          previous_session_url: session.previousSessionUrl,
          dropped_network_count: session.droppedNetworkCount,
          dropped_interaction_count: session.droppedInteractionCount,
        }] },
      }] : []),
      ...(exchanges.length > 0
        ? [{
            namespace: 'network',
            key: 'captured-exchanges',
            schema_version: 1,
            payload: { version: 1, exchanges },
          }]
        : []),
      ...(session.capturedInteractions.length !== session.queuedCapturedInteractionCount ? [{
        namespace: 'interaction',
        key: 'captured-interactions',
        schema_version: 1,
        payload: { version: 1, interactions: session.capturedInteractions.slice(session.queuedCapturedInteractionCount) },
      }] : []),
      ...(session.interactionCount !== session.queuedInteractionCount ? [{
        namespace: 'session',
        key: 'metrics',
        schema_version: 1,
        payload: { version: 1, interaction_count: session.interactionCount },
      }] : []),
      ...(session.userEmail && session.userEmail !== session.queuedUserEmail ? [{
        namespace: 'session',
        key: 'identity',
        schema_version: 1,
        payload: { version: 1, email: session.userEmail },
      }] : []),
    ]
    if (auxiliaryData.length === 0) return session.uploadChain
    session.queuedContext = context
    session.queuedExchangeCount = session.capturedExchanges.length
    session.queuedInteractionCount = session.interactionCount
    session.queuedCapturedInteractionCount = session.capturedInteractions.length
    session.queuedUserEmail = session.userEmail
    const body = {
      session_url: session.sessionUrl,
      auxiliary_data: auxiliaryData,
    }

    // Each immutable batch is retried with the same event IDs; the server deduplicates it.
    session.uploadChain = session.uploadChain
      .then(async () => {
        if (session.uploadsStopped) return
        const response = await sendCaptureBatch(JSON.stringify(body))
        if (shouldStopSessionUploads(response.status)) session.uploadsStopped = true
        if (!response.ok && response.status !== 409) {
          throw new Error(`Replay QA session upload failed: ${response.status}`)
        }
      })
      .catch(error => {
        session.uploadsStopped = true
        console.error(error)
      })
    return session.uploadChain
  }

  function uploadCapture(session: CaptureSession): void {
    if (!session.sessionUrl || session.uploadsStopped) return
    if (session.uploadTimer) return
    session.uploadTimer = setTimeout(() => {
      session.uploadTimer = null
      void queueCaptureUpload(session)
    }, 250)
  }

  function selectorFor(element: Element): string | null {
    const tag = element.tagName.toLowerCase()
    const testId = element.getAttribute('data-testid')
    const candidate = (selector: string) => selector.length <= 2_000 ? selector : null
    if (testId) return candidate(`[data-testid=${JSON.stringify(testId)}]`)
    if (element.id) return candidate(`#${CSS.escape(element.id)}`)
    const ariaLabel = element.getAttribute('aria-label')
    if (ariaLabel) return candidate(`${tag}[aria-label=${JSON.stringify(ariaLabel)}]`)
    const name = element.getAttribute('name')
    if (name) return candidate(`${tag}[name=${JSON.stringify(name)}]`)
    const label = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 500)
    return label ? candidate(`${tag}:has-text(${JSON.stringify(label)})`) : null
  }

  function recordInteraction(event: Event): void {
    if (!event.isTrusted) return
    const session = captureSession()
    if (!session) return
    if (countsAsSessionInteraction(event)) session.interactionCount++
    if (session.capturedInteractions.length >= MAX_CAPTURED_INTERACTIONS) {
      session.droppedInteractionCount++
      return uploadCapture(session)
    }
    const path = event.composedPath().filter((item): item is Element => item instanceof Element)
    const target = path.find(element => element.matches(ACTIONABLE_SELECTOR)) ?? path[0]
    const selector = target ? selectorFor(target) : null
    const label = target
      ? (target.getAttribute('aria-label') || target.textContent || target.tagName)
        .replace(/\s+/g, ' ').trim().slice(0, 500)
      : null
    const textTarget = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
    const editable = target instanceof HTMLElement && target.isContentEditable
    const keyboard = event instanceof KeyboardEvent ? {
      key: event.key, code: event.code, altKey: event.altKey, ctrlKey: event.ctrlKey,
      metaKey: event.metaKey, shiftKey: event.shiftKey, repeat: event.repeat, isComposing: event.isComposing,
    } : {}
    session.capturedInteractions.push({
      id: crypto.randomUUID(),
      captured_at: performance.timeOrigin + performance.now(),
      source_timestamp: Math.round(performance.now()),
      kind: event.type as CapturedInteraction['kind'],
      selector,
      label: label || null,
      tag_name: target?.tagName.toLowerCase(),
      ...keyboard,
      ...(['input', 'change'].includes(event.type) && (textTarget || editable) ? { value: textTarget ? target.value : target.textContent ?? '' } : {}),
      ...(event instanceof ClipboardEvent && event.type === 'paste' ? { text: event.clipboardData?.getData('text/plain') ?? '' } : {}),
      ...(event instanceof InputEvent ? { inputType: event.inputType, isComposing: event.isComposing } : {}),
    })
    uploadCapture(session)
  }

  for (const eventName of CAPTURED_SESSION_INTERACTION_EVENTS) {
    window.addEventListener(eventName, recordInteraction, { capture: true })
  }

  async function replayForFullStory(exchange: CapturedExchange): Promise<void> {
    syntheticExchange = exchange
    try {
      // FullStory observes this synthetic response without issuing a second backend request.
      await window.fetch(exchange.url, {
        method: exchange.method,
        headers: { 'x-fs-recapture': '1' },
      })
    } finally {
      syntheticExchange = null
    }
  }

  window.fetch = async (input, init) => {
    const request = new Request(input, init)
    const synthetic = syntheticExchange
    if (
      synthetic &&
      request.headers.get('x-fs-recapture') === '1' &&
      request.method === synthetic.method &&
      request.url === synthetic.url
    ) {
      return new Response(
        synthetic.startup_body?.byteLength ? synthetic.startup_body.slice(0) : null,
        {
          status: synthetic.status,
          statusText: synthetic.status_text,
          headers: synthetic.response_headers,
        },
      )
    }

    const session = captureSession()
    if (!session) return nativeFetch(request)
    const startedBeforeReady = !fullStoryReady
    const sourceTimestamp = Math.round(performance.now())
    const capturedAt = performance.timeOrigin + sourceTimestamp
    const exchangeId = crypto.randomUUID()
    const requestBody =
      request.method !== 'GET' && request.method !== 'HEAD'
        ? boundedBody(request).catch(() => null)
        : Promise.resolve(null)
    const response = await nativeFetch(request)
    const clone = response.clone()
    const responseBytes = await clone.arrayBuffer().catch(() => null)
    const capturedRequestBody = await requestBody
    const exchangeBytes =
      (responseBytes?.byteLength ?? 0) +
      new TextEncoder().encode(capturedRequestBody ?? '').byteLength
    if (session.capturedBytes + exchangeBytes > MAX_CAPTURE_BYTES || session.capturedExchanges.length >= 5_000) {
      session.droppedNetworkCount++
      uploadCapture(session)
      return response
    }

    const exchange: CapturedExchange = {
      id: exchangeId,
      captured_at: capturedAt,
      source_timestamp: sourceTimestamp,
      method: request.method,
      url: request.url,
      status: clone.status,
      request_headers: Object.fromEntries(request.headers.entries()),
      request_body: capturedRequestBody,
      response_headers: Object.fromEntries(clone.headers.entries()),
      response_body:
        responseBytes && responseBytes.byteLength <= MAX_BODY_BYTES
          ? new TextDecoder().decode(responseBytes)
          : null,
      ...(startedBeforeReady &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      responseBytes &&
      responseBytes.byteLength <= MAX_BODY_BYTES
        ? { startup_body: responseBytes, status_text: clone.statusText }
        : {}),
    }
    session.capturedBytes += exchangeBytes
    session.capturedExchanges.push(exchange)
    uploadCapture(session)
    if (fullStoryReady && exchange.startup_body) {
      await replayForFullStory(exchange)
      delete exchange.startup_body
      delete exchange.status_text
    }
    return response
  }

  init({ orgId }, async ({ sessionUrl }) => {
    const session = synchronizeSession(sessionUrl)
    const firstStart = !fullStoryReady
    fullStoryReady = true
    if (firstStart) {
      for (const exchange of session.capturedExchanges.filter(item => item.startup_body)) {
        await replayForFullStory(exchange)
        delete exchange.startup_body
        delete exchange.status_text
      }
    }
    if (session.uploadTimer) clearTimeout(session.uploadTimer)
    session.uploadTimer = null
    await queueCaptureUpload(session)
  })
  // init() above registers the SDK synchronously and queues any API calls made before the session is
  // ready, so identify is safe from here on. Setting the flag outside the ready callback keeps an
  // identify that lands between init() and session-ready working rather than crashing.
  fullStoryInitialized = true
}
```

Initialize the shim before rendering the application:

```ts
initFullStory()
// After authentication, call identifyFullStoryUser({ id, name, email }).
```

Request and response bodies larger than 1 MB are recorded as `null`. The network budget is 8 MB
and the interaction limit is 5,000 per FullStory session on this page. Reaching either limit updates
`session/capture-context` with explicit drop counts; the application still receives its response.
All auxiliary types share session ownership, immutable retry batches, upload timers, and failure
handling. A stopped upload only affects its owning session. Each new session resends identity and
starts fresh counters. Events retain absolute `captured_at` times; page-relative `source_timestamp`
is legacy metadata, not a FullStory timestamp. The importer aligns absolute times with the recorded
FullStory session start.

`session/capture-context` carries a page-lifetime ID, its absolute start time, and the preceding
FullStory session URL on that page. Earlier captures remain associated with their original sessions,
so this link records preceding context without pretending its events occurred in the new session.
Uploads use native fetch and are not captured recursively. Network/server errors retry the identical
batch three times; stable event IDs deduplicate retries. Do not move pending responses or old batches
to a newly started session.

