---
name: setup-self-healing
description: Guide a coding agent through account provisioning, project connection, session capture, and verification of real QA results.
---

# Set up Self Healing for this project

Use this skill when the user asks to enable Self Healing in an application. Do the integration work in the current project; ask the user only for missing credentials, deployment access, or choices you cannot infer. A user pasting the setup prompt is asking you to perform setup, not just explain the API.

## Discover the service and inspect the project

Use the origin from which you downloaded this skill as `SELF_HEALING_URL`. Resolve every `/api/...` path below against that same origin. GET `/api/v1` for discovery, `/api/v1/skills` for available skills, and `/api/v1/openapi.json` for request/response schemas and implementation status. These are public; no key is needed to read them.

Inspect the project's framework, server routes, deployment configuration, secret manager, and existing Fullstory/capture integration. Reuse existing instrumentation rather than installing a second copy. Identify the production HTTPS URL and a readable project name. Locate any existing `SELF_HEALING_API_KEY` in its secret manager without printing its value. Do not create a new account when an existing working one is available.

Initial setup supports session ingestion, QA reviews, reproduction journeys requested by friction reviews, and daily behavior reports. Providing a key does not discover historical sessions or install browser capture. Automatic fix-PR orchestration, event streams, delivery integrations, and other routes marked `planned` are not implemented; do not present saved configuration or a 501 response as working functionality.

## Provision and store the account key

If the project has no Self Healing account key, request a Subtext API key with access to its Fullstory sessions through the user's secure secret input. Do not ask the user to paste it into source code or commit it. Never print credentials, return them in status reports, or embed them in client bundles.

POST `/api/v1/accounts` (`provisionAccount`) with `Content-Type: application/json` and this body, substituting the key securely:

```json
{"subtext_api_key":"<Subtext key>"}
```

No bearer key is required for this provisioning request: Self Healing validates the supplied Subtext key. The response contains `account_id` and `api_key`. Save `api_key` as `SELF_HEALING_API_KEY` in the application's server-side secret manager and set `SELF_HEALING_URL` to this service's origin. A local ignored environment file may be used for development. The application needs neither a QA token nor the service's infrastructure secrets.

All subsequent API calls use `Authorization: Bearer <SELF_HEALING_API_KEY>`, **not the Subtext key**. Each account has its own QA identity; Self Healing retains the encrypted provider credentials and mediates QA's session access. Once provisioning succeeds, the application does not need to retain its Subtext key for these API calls.

Repeating provisioning with the same valid Subtext key recovers the same account and API key. A different Subtext key creates another account even within the same Fullstory organization; do not substitute a new key to recover an existing integration. Account key rotation is not implemented. If provisioning returns `account_busy`, retry with backoff. If it returns `provisioning_pending`, stop provisioning and report that the service operator must reconcile an uncertain QA token issuance. Do not work around it by changing keys.

## Connect the application

GET `/api/v1/connection` using the account key. If it is connected, reuse its IDs. If it returns `not_connected`, POST the same path with:

```json
{"name":"My application","production_url":"https://app.example.com"}
```

Recover interrupted setup by repeating that exact POST. Save the chosen name and URL in project configuration so retries use identical values. The connection creates one QA project for the account and configures reviews and daily reports. Different settings return 409; do not create a replacement account to bypass this conflict. The older `/api/v1/projects` configuration API is not a substitute for connection provisioning.

A connected response confirms configuration, not a successful review. QA project creation can start initial exploration, and QA work requires credit capacity. Report quota or credit blocks to the user/service operator; do not promise free or unlimited work.

## Install the capture package

The capture implementation is maintained in [`@replayio/self-healing-capture`](https://www.npmjs.com/package/@replayio/self-healing-capture). Install it; do not copy or generate a fetch wrapper. Its [package README](https://github.com/replayio/self-healing/tree/main/packages/capture) documents its API and supported capture behavior.

1. Inspect the application for an existing FullStory initialization or copied capture shim. Replace that shim with this package, preserving the existing organization ID and identity hook. There must be one recorder/FullStory initialization.
2. If the app has no FullStory organization, run `npx @subtextdev/subtext-wizard` to select the organization accessible through the Subtext key used to provision this account.
3. Install the package and its FullStory peer dependency:

```sh
npm install @replayio/self-healing-capture @fullstory/browser
```

If the package has not yet been published, report that release dependency; do not fall back to copying source. In the production browser entry point, before rendering (not during SSR):

```ts
import { initCapture } from '@replayio/self-healing-capture'

export const capture = initCapture({
  orgId: '<FULLSTORY_ORG_ID>',
  endpoint: '/api/self-healing/session',
  onError: error => console.error('Session capture failed', error),
})

// In the app's existing authentication callback:
capture.identify({ id: user.id, name: user.name, email: user.email })
```

The package owns network, interaction, identity, metrics and session-context generation, timestamps, session rollover, batching and retries. Preserve the app's existing capture policy. Do not add a generic field-redaction layer. Keep dependencies locked and upgrade the package to receive capture fixes.

## Forward captures through Self Healing

Mount this handler at POST `/api/self-healing/session` using the application's server framework. For example, in a Next.js App Router project, place it in `app/api/self-healing/session/route.ts` and export `POST`. Use the application's existing server-side environment access if it does not use `process.env`.

```ts
export async function POST(request: Request): Promise<Response> {
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > 256 * 1024) {
    return Response.json({ error: 'Capture exceeds Self Healing request limit' }, { status: 413 })
  }
  const response = await fetch(
    new URL('/api/v1/connection/sessions', process.env.SELF_HEALING_URL),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SELF_HEALING_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body,
    },
  )
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'Content-Type': 'application/json' },
  })
}
```

Use the app's existing access controls for its capture route. The forwarding handler above supplies the transport, not application-specific authentication. Store `SELF_HEALING_URL` and `SELF_HEALING_API_KEY` on the server. Do not put a QA token or Subtext key in this route or in the browser. Do not call QA's registration endpoint: Self Healing attaches the QA ingestion credential and session-source callback itself.

The producer sends `{session_url, auxiliary_data}`; omitting `complete` means `false`. Self Healing forwards those artifacts to QA. It does not transform or store the capture bodies locally.

The package splits batches internally at 256 KiB. An oversized individual event is reported through `onError` and causes `capture.flush()` to reject; do not treat that session's capture as complete. There is no event-fragment API or durable offline queue. Installers do not implement batching or modify captured event fields themselves.

## Complete a session and trigger reviews

The package uploads capture data but does **not** send Self Healing's `complete:true`. Self Healing does not currently detect session completion automatically. Do not seal a session on each upload, page navigation, or browser unload: a FullStory session can span pages, and sealing rejects new captures.

For the first integration test, use a dedicated session. Finish its activity, call `await capture.stop()` on its active page(s) to stop new capture and flush pending uploads, and stop FullStory recording for that test session before issuing this server-side request with the account bearer key:

```json
{"session_url":"<the completed test session URL>","auxiliary_data":[],"complete":true}
```

POST it to `/api/v1/connection/sessions`. Retry the identical completion request after a transport failure. Completion seals the session and requests goals/outcomes and friction/recovery reviews. A successful response acknowledges the handoff, not successful analysis. Friction reviews can request reproduction journeys.

For unattended operation, identify an existing mechanism in the application that knows a FullStory session has ended and that all its uploads have succeeded. If there is none, report session finalization as remaining integration work. The capture package and Self Healing API do not supply that mechanism; do not describe the integration as automatically reviewing every session until it exists and has been verified.

## Verify before declaring setup complete

- Run the target project's relevant tests/build. Exercise a real fetch, click/input, and signed-in identity update; verify the producer sends their artifacts through the local route to Self Healing. Check that the account key stays server-side and the route uses the app's intended access controls.
- Deploy using the project's normal workflow and permissions. If deployment requires user action, report that boundary and provide the concrete change for review.
- Submit one real accessible session with captured network and interaction events. Confirm the upload and completion responses, then poll `GET /api/v1/connection/reviews?reviewer=friction-and-recovery&page=0` and the `goals-and-outcomes` reviewer. Inspect the actual task state/result; empty results or an accepted request are not proof of a completed review. Use bounded polling/backoff and report outstanding work without repeatedly resubmitting completion.
- Daily reports are scheduled at 08:00 UTC for the previous day. The first eligible report covers the connection's setup day and runs the next morning. Read `GET /api/v1/connection/reports?day=YYYY-MM-DD`. The POST report endpoint only reads/awaits the scheduler; it does not force a report immediately. State when a report is not yet eligible instead of fabricating a result.

Report the account and QA project IDs, installed capture/server components, deployment status, first session/review evidence, and any remaining blockers. Never include API keys or secret callback URLs. Distinguish "configured", "review verified", and "first report pending" when appropriate. Do not claim the complete automatic fix factory is active.

For ongoing operation, read `/api/v1/skills/operate-self-healing/SKILL.md`. On 401, check which credential is being used and do not fall back to Subtext bearer authentication. On 429 retry with backoff. On 503 or `provisioning_pending`, preserve IDs and report the operator action needed. On 501, stop that unsupported operation; never invent a replacement provider API.
