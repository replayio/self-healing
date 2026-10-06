import { FullStory, init } from "@fullstory/browser";
import {
  decodeCaptureBody,
  splitBatches,
  DEFAULT_MAX_NETWORK_CAPTURE_BYTES,
  type Artifact,
} from "./transport.js";

export interface CaptureOptions {
  orgId: string;
  /** Same-origin POST route holding the server-side credential. */
  endpoint?: string;
  /** Maximum UTF-8 JSON bytes per network exchange (bodies, headers and metadata). Defaults to 1,000,000. */
  maxNetworkCaptureBytes?: number;
  onError?: (error: Error) => void;
}
export interface CaptureController {
  identify(user: FullStoryUser | null): void;
  /** Wait for in-flight captures and upload all known sessions. Rejects on capture/upload failure. */
  flush(): Promise<void>;
  /** Stop new capture and flush existing data; does not seal a FullStory session. */
  stop(): Promise<void>;
}
let active: CaptureController | undefined;
let activeOptions: CaptureOptions | undefined;
const CAPTURED_SESSION_INTERACTION_EVENTS = [
  "click",
  "change",
  "input",
  "paste",
  "keydown",
  "keyup",
] as const;
function countsAsSessionInteraction(event: Event): boolean {
  return (
    event.type === "click" ||
    event.type === "change" ||
    (event instanceof KeyboardEvent &&
      event.type === "keydown" &&
      ["Enter", "Escape"].includes(event.key))
  );
}

type CapturedExchange = {
  id: string;
  captured_at: number;
  source_timestamp: number;
  method: string;
  url: string;
  status: number;
  request_headers: Record<string, string>;
  request_body: string | null;
  response_headers: Record<string, string>;
  response_body: string | null;
  startup_body?: ArrayBuffer;
  status_text?: string;
};

type CapturedInteraction = {
  id: string;
  captured_at: number;
  source_timestamp: number;
  kind: "click" | "change" | "input" | "paste" | "keydown" | "keyup";
  selector: string | null;
  label: string | null;
  tag_name?: string;
  value?: string;
  text?: string;
  key?: string;
  code?: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  inputType?: string;
};

const MAX_CAPTURE_BYTES = 8_000_000;
const MAX_CAPTURED_INTERACTIONS = 5_000;
const ACTIONABLE_SELECTOR =
  'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [role="option"], [role="radio"], [role="switch"], [role="tab"], [contenteditable="true"]';
let setCapturedUserEmail: ((email: string) => void) | null = null;
let fullStoryInitialized = false;

export interface FullStoryUser {
  id: string;
  name: string;
  email: string | null;
}

/** Identify the authenticated user in FullStory and attach their email to Replay QA's session record. */
function identifyFullStoryUser(user: FullStoryUser | null): void {
  if (!fullStoryInitialized || !user) return;
  FullStory("setIdentity", {
    uid: user.id,
    properties: {
      displayName: user.name,
      ...(user.email ? { email: user.email } : {}),
    },
  });
  if (user.email) setCapturedUserEmail?.(user.email);
}

export function initCapture(options: CaptureOptions): CaptureController {
  if (typeof window === "undefined")
    throw new Error("initCapture must run in the browser");
  const maxNetworkCaptureBytes =
    options.maxNetworkCaptureBytes ?? DEFAULT_MAX_NETWORK_CAPTURE_BYTES;
  if (
    !Number.isSafeInteger(maxNetworkCaptureBytes) ||
    maxNetworkCaptureBytes <= 0
  )
    throw new Error("maxNetworkCaptureBytes must be a positive safe integer");
  if (active) {
    if (
      options.orgId !== activeOptions?.orgId ||
      options.endpoint !== activeOptions?.endpoint ||
      maxNetworkCaptureBytes !==
        (activeOptions?.maxNetworkCaptureBytes ??
          DEFAULT_MAX_NETWORK_CAPTURE_BYTES)
    ) {
      throw new Error("Capture is already initialized with different options");
    }
    return active;
  }
  if (!options.orgId)
    throw new Error("A FullStory organization ID is required");
  const endpoint = new URL(
    options.endpoint ?? "/api/self-healing/session",
    window.location.href,
  );
  if (
    endpoint.origin !== window.location.origin ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error("Capture endpoint must be same-origin");
  }
  const orgId = options.orgId;
  let stopped = false;
  let lastError: Error | undefined;
  const reportError = (error: unknown) => {
    lastError = error instanceof Error ? error : new Error(String(error));
    try {
      (options.onError ?? console.error)(lastError);
    } catch {
      /* observers cannot break the app */
    }
  };
  const inFlight = new Set<Promise<unknown>>();
  const nativeFetch = window.fetch.bind(window);
  const pageId = crypto.randomUUID();
  let userEmail: string | null = null;
  let fullStoryReady = false;
  let syntheticExchange: CapturedExchange | null = null;

  // All auxiliary producers use this same session object, including work finishing after rollover.
  function createCaptureSession(
    sessionUrl: string | null,
    previousSessionUrl: string | null,
  ) {
    return {
      sessionUrl,
      previousSessionUrl,
      capturedExchanges: [] as CapturedExchange[],
      capturedInteractions: [] as CapturedInteraction[],
      capturedBytes: 0,
      interactionCount: 0,
      queuedExchangeCount: 0,
      queuedInteractionCount: -1,
      queuedCapturedInteractionCount: 0,
      pendingBatches: [] as string[],
      uploadError: undefined as Error | undefined,
      userEmail,
      queuedUserEmail: null as string | null,
      uploadTimer: null as ReturnType<typeof setTimeout> | null,
      uploadChain: Promise.resolve(),
      droppedNetworkCount: 0,
      droppedInteractionCount: 0,
      queuedContext: "",
    };
  }
  type CaptureSession = ReturnType<typeof createCaptureSession>;
  let currentSession = createCaptureSession(null, null);
  const sessions = new Set<CaptureSession>([currentSession]);

  function synchronizeSession(sessionUrl: string): CaptureSession {
    if (currentSession.sessionUrl !== sessionUrl) {
      if (currentSession.sessionUrl === null) {
        // Requests made before SDK readiness belong to the first session, even if still in flight.
        currentSession.sessionUrl = sessionUrl;
      } else {
        const previous = currentSession;
        if (previous.uploadTimer) clearTimeout(previous.uploadTimer);
        previous.uploadTimer = null;
        void queueCaptureUpload(previous);
        currentSession = createCaptureSession(sessionUrl, previous.sessionUrl);
        sessions.add(currentSession);
      }
      uploadCapture(currentSession);
    }
    return currentSession;
  }

  function captureSession(): CaptureSession | null {
    if (!fullStoryReady) return currentSession;
    // Read at the event boundary: an idle tab can resume into a new FullStory session without reload.
    try {
      const sessionUrl = FullStory("getSession", { format: "url" });
      return sessionUrl ? synchronizeSession(sessionUrl) : null;
    } catch {
      // Stopped/unavailable recording must not assign new events to a stale session.
      return null;
    }
  }

  setCapturedUserEmail = (email) => {
    userEmail = email;
    const session = captureSession();
    if (!session) return;
    session.userEmail = email;
    uploadCapture(session);
  };

  async function captureBody(
    value: Request | Response,
  ): Promise<string | null> {
    const bytes = await value.clone().arrayBuffer();
    return decodeCaptureBody(bytes);
  }

  async function sendCaptureBatch(body: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await nativeFetch(endpoint.href, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        if (attempt === 2) return response;
        const busy =
          response.status === 409 &&
          (
            await response
              .clone()
              .json()
              .catch(() => null)
          )?.error?.code === "upload_busy";
        if (response.status < 500 && response.status !== 429 && !busy)
          return response;
      } catch (error) {
        if (attempt === 2) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }

  function queueCaptureUpload(session: CaptureSession): Promise<void> {
    if (!session.sessionUrl) return Promise.resolve();
    session.uploadChain = session.uploadChain.then(() =>
      drainCaptureUpload(session),
    );
    return session.uploadChain;
  }

  async function drainCaptureUpload(session: CaptureSession): Promise<void> {
    const exchanges = session.capturedExchanges
      .slice(session.queuedExchangeCount)
      .map(
        ({ startup_body: _body, status_text: _status, ...exchange }) =>
          exchange,
      )
      .sort((a, b) => a.source_timestamp - b.source_timestamp);
    const context = JSON.stringify({
      id: pageId,
      page_started_at: performance.timeOrigin,
      previous_session_url: session.previousSessionUrl,
      dropped_network_count: session.droppedNetworkCount,
      dropped_interaction_count: session.droppedInteractionCount,
    });
    const auxiliaryData: Artifact[] = [
      {
        namespace: "session",
        key: "capture-producer",
        schema_version: 1,
        payload: { name: "@replayio/self-healing-capture", version: "0.1.3" },
      },
      ...(context !== session.queuedContext || session.pendingBatches.length > 0
        ? [
            {
              namespace: "session",
              key: "capture-context",
              schema_version: 1,
              payload: {
                version: 1,
                pages: [
                  {
                    id: pageId,
                    page_started_at: performance.timeOrigin,
                    previous_session_url: session.previousSessionUrl,
                    dropped_network_count: session.droppedNetworkCount,
                    dropped_interaction_count: session.droppedInteractionCount,
                  },
                ],
              },
            },
          ]
        : []),
      ...(exchanges.length > 0
        ? [
            {
              namespace: "network",
              key: "captured-exchanges",
              schema_version: 1,
              payload: { version: 1, exchanges },
            },
          ]
        : []),
      ...(session.capturedInteractions.length !==
      session.queuedCapturedInteractionCount
        ? [
            {
              namespace: "interaction",
              key: "captured-interactions",
              schema_version: 1,
              payload: {
                version: 1,
                interactions: session.capturedInteractions.slice(
                  session.queuedCapturedInteractionCount,
                ),
              },
            },
          ]
        : []),
      ...(session.interactionCount !== session.queuedInteractionCount ||
      session.pendingBatches.length > 0
        ? [
            {
              namespace: "session",
              key: "metrics",
              schema_version: 1,
              payload: {
                version: 1,
                interaction_count: session.interactionCount,
              },
            },
          ]
        : []),
      ...(session.userEmail &&
      (session.userEmail !== session.queuedUserEmail ||
        session.pendingBatches.length > 0)
        ? [
            {
              namespace: "session",
              key: "identity",
              schema_version: 1,
              payload: { version: 1, email: session.userEmail },
            },
          ]
        : []),
    ];
    if (auxiliaryData.length === 1 && !session.pendingBatches.length) return;
    let batches: string[];
    try {
      batches = splitBatches(
        {
          session_url: session.sessionUrl!,
          auxiliary_data: auxiliaryData,
        },
        maxNetworkCaptureBytes,
      );
    } catch (error) {
      reportError(error);
      return;
    }
    session.queuedContext = context;
    session.queuedExchangeCount = session.capturedExchanges.length;
    session.queuedInteractionCount = session.interactionCount;
    session.queuedCapturedInteractionCount =
      session.capturedInteractions.length;
    session.queuedUserEmail = session.userEmail;
    session.pendingBatches.push(...batches);
    const failed: string[] = [];
    session.uploadError = undefined;
    // Retry identical event IDs, but a rejected batch must not block later interactions.
    for (const batch of session.pendingBatches) {
      try {
        const response = await sendCaptureBatch(batch);
        if (!response.ok)
          throw new Error(`Capture upload failed: ${response.status}`);
      } catch (error) {
        failed.push(batch);
        session.uploadError =
          error instanceof Error ? error : new Error(String(error));
        try {
          (options.onError ?? console.error)(session.uploadError);
        } catch {
          /* observers cannot break the app */
        }
      }
    }
    session.pendingBatches = failed;
  }

  function uploadCapture(session: CaptureSession): void {
    if (!session.sessionUrl) return;
    if (session.uploadTimer) return;
    session.uploadTimer = setTimeout(() => {
      session.uploadTimer = null;
      void queueCaptureUpload(session);
    }, 250);
  }

  function selectorFor(element: Element): string | null {
    const tag = element.tagName.toLowerCase();
    const testId = element.getAttribute("data-testid");
    const candidate = (selector: string) =>
      selector.length <= 2_000 ? selector : null;
    if (testId) return candidate(`[data-testid=${JSON.stringify(testId)}]`);
    if (element.id) return candidate(`#${CSS.escape(element.id)}`);
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel)
      return candidate(`${tag}[aria-label=${JSON.stringify(ariaLabel)}]`);
    const name = element.getAttribute("name");
    if (name) return candidate(`${tag}[name=${JSON.stringify(name)}]`);
    const label = (element.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
    return label
      ? candidate(`${tag}:has-text(${JSON.stringify(label)})`)
      : null;
  }

  function recordInteraction(event: Event): void {
    if (stopped || !event.isTrusted) return;
    const session = captureSession();
    if (!session) return;
    if (countsAsSessionInteraction(event)) session.interactionCount++;
    if (session.capturedInteractions.length >= MAX_CAPTURED_INTERACTIONS) {
      session.droppedInteractionCount++;
      return uploadCapture(session);
    }
    const path = event
      .composedPath()
      .filter((item): item is Element => item instanceof Element);
    const target =
      path.find((element) => element.matches(ACTIONABLE_SELECTOR)) ?? path[0];
    const selector = target ? selectorFor(target) : null;
    const label = target
      ? (
          target.getAttribute("aria-label") ||
          target.textContent ||
          target.tagName
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 500)
      : null;
    const textTarget =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;
    const editable = target instanceof HTMLElement && target.isContentEditable;
    const keyboard =
      event instanceof KeyboardEvent
        ? {
            key: event.key,
            code: event.code,
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
            repeat: event.repeat,
            isComposing: event.isComposing,
          }
        : {};
    session.capturedInteractions.push({
      id: crypto.randomUUID(),
      captured_at: performance.timeOrigin + performance.now(),
      source_timestamp: Math.round(performance.now()),
      kind: event.type as CapturedInteraction["kind"],
      selector,
      label: label || null,
      tag_name: target?.tagName.toLowerCase(),
      ...keyboard,
      ...(["input", "change"].includes(event.type) && (textTarget || editable)
        ? { value: textTarget ? target.value : (target.textContent ?? "") }
        : {}),
      ...(event instanceof ClipboardEvent && event.type === "paste"
        ? { text: event.clipboardData?.getData("text/plain") ?? "" }
        : {}),
      ...(event instanceof InputEvent
        ? { inputType: event.inputType, isComposing: event.isComposing }
        : {}),
    });
    uploadCapture(session);
  }

  for (const eventName of CAPTURED_SESSION_INTERACTION_EVENTS) {
    window.addEventListener(eventName, recordInteraction, { capture: true });
  }

  async function replayForFullStory(exchange: CapturedExchange): Promise<void> {
    syntheticExchange = exchange;
    try {
      // FullStory observes this synthetic response without issuing a second backend request.
      await window.fetch(exchange.url, {
        method: exchange.method,
        headers: { "x-fs-recapture": "1" },
      });
    } finally {
      syntheticExchange = null;
    }
  }

  window.fetch = async (input, init) => {
    if (stopped) return nativeFetch(input, init);
    const request = new Request(
      input instanceof Request
        ? input
        : new URL(String(input), window.location.href),
      init,
    );
    if (request.url === endpoint.href) return nativeFetch(request);
    const synthetic = syntheticExchange;
    if (
      synthetic &&
      request.headers.get("x-fs-recapture") === "1" &&
      request.method === synthetic.method &&
      request.url === synthetic.url
    ) {
      return new Response(
        synthetic.startup_body?.byteLength
          ? synthetic.startup_body.slice(0)
          : null,
        {
          status: synthetic.status,
          statusText: synthetic.status_text,
          headers: synthetic.response_headers,
        },
      );
    }

    const session = captureSession();
    if (!session) return nativeFetch(request);
    const startedBeforeReady = !fullStoryReady;
    const sourceTimestamp = Math.round(performance.now());
    const capturedAt = performance.timeOrigin + sourceTimestamp;
    const exchangeId = crypto.randomUUID();
    const requestBody =
      request.method !== "GET" && request.method !== "HEAD"
        ? captureBody(request).catch(() => null)
        : Promise.resolve(null);
    const responsePromise = nativeFetch(request);
    inFlight.add(responsePromise);
    let response: Response;
    try {
      response = await responsePromise;
    } finally {
      inFlight.delete(responsePromise);
    }
    const capture = (async () => {
      const clone = response.clone();
      const responseBytes = await clone.arrayBuffer().catch(() => null);
      const capturedRequestBody = await requestBody;
      const exchangeBytes =
        (responseBytes?.byteLength ?? 0) +
        new TextEncoder().encode(capturedRequestBody ?? "").byteLength;
      if (
        session.capturedBytes + exchangeBytes > MAX_CAPTURE_BYTES ||
        session.capturedExchanges.length >= 5_000
      ) {
        session.droppedNetworkCount++;
        uploadCapture(session);
        return;
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
        response_body: responseBytes ? decodeCaptureBody(responseBytes) : null,
        ...(startedBeforeReady &&
        (request.method === "GET" || request.method === "HEAD") &&
        responseBytes
          ? { startup_body: responseBytes, status_text: clone.statusText }
          : {}),
      };
      const {
        startup_body: _startup,
        status_text: _status,
        ...uploadedExchange
      } = exchange;
      if (
        new TextEncoder().encode(JSON.stringify(uploadedExchange)).byteLength >
        maxNetworkCaptureBytes
      ) {
        session.droppedNetworkCount++;
        uploadCapture(session);
        return;
      }
      session.capturedBytes += exchangeBytes;
      session.capturedExchanges.push(exchange);
      uploadCapture(session);
      if (!stopped && fullStoryReady && exchange.startup_body) {
        await replayForFullStory(exchange);
        delete exchange.startup_body;
        delete exchange.status_text;
      }
    })().catch(reportError);
    inFlight.add(capture);
    void capture.finally(() => inFlight.delete(capture));
    return response;
  };

  const controller: CaptureController = {
    identify: (user) => {
      if (!stopped) identifyFullStoryUser(user);
    },
    async flush() {
      while (inFlight.size) await Promise.allSettled([...inFlight]);
      for (const session of sessions) {
        if (session.uploadTimer) clearTimeout(session.uploadTimer);
        session.uploadTimer = null;
        await queueCaptureUpload(session);
      }
      if (lastError) throw lastError;
      for (const session of sessions) {
        if (session.uploadError) throw session.uploadError;
      }
      if (!currentSession.sessionUrl)
        throw new Error("FullStory session is not ready");
    },
    async stop() {
      stopped = true;
      for (const eventName of CAPTURED_SESSION_INTERACTION_EVENTS) {
        window.removeEventListener(eventName, recordInteraction, {
          capture: true,
        });
      }
      await controller.flush();
    },
  };
  active = controller;
  activeOptions = { ...options };
  init({ orgId }, async ({ sessionUrl }) => {
    if (stopped && currentSession.sessionUrl !== null) return;
    const session = synchronizeSession(sessionUrl);
    const firstStart = !fullStoryReady;
    fullStoryReady = true;
    if (firstStart) {
      for (const exchange of session.capturedExchanges.filter(
        (item) => !stopped && item.startup_body,
      )) {
        await replayForFullStory(exchange);
        delete exchange.startup_body;
        delete exchange.status_text;
      }
    }
    if (session.uploadTimer) clearTimeout(session.uploadTimer);
    session.uploadTimer = null;
    await queueCaptureUpload(session);
  });
  // init() above registers the SDK synchronously and queues any API calls made before the session is
  // ready, so identify is safe from here on. Setting the flag outside the ready callback keeps an
  // identify that lands between init() and session-ready working rather than crashing.
  fullStoryInitialized = true;
  return controller;
}
