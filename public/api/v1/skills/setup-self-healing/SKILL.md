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

## Implement capture and a server-side forwarding route

1. Reuse or install Fullstory capture in the target application. Consult the current official Fullstory documentation for the framework in this project; use the correct organization and privacy/masking configuration. If the organization or capture permissions are unavailable, ask for them and continue independent server integration work. Obtain a real session URL accessible through the provisioned Subtext key.
2. Add a same-origin server endpoint that authenticates the application's capture caller, authorizes the session, validates bounded payloads, and forwards to `POST /api/v1/connection/sessions`. It adds the Self Healing bearer key from server-side storage. Never expose that key to the browser or implement an unauthenticated general-purpose forwarding proxy.
3. Capture auxiliary network events using the app's existing capture producers when available. Redact authorization headers, cookies, credentials, private query parameters and sensitive request/response fields before upload. Preserve stable event IDs, original capture times, method/URL/status, and useful redacted bodies. Avoid capturing the forwarding endpoint itself. Do not collect secrets just to redact them later on the server.
4. Forward batches with `complete:false`, keeping each entire JSON request under 256 KiB. Wait for all batches to succeed before completing the session. Retry identical batches with the same event IDs and payloads. Split before sending oversized batches. Do not silently omit failed captures or represent failed uploads as successful.

A minimal supported network batch is:

```json
{
  "session_url":"https://app.fullstory.com/ui/ORG/client-session/123:456",
  "auxiliary_data":[{
    "namespace":"network",
    "key":"captured-exchanges",
    "schema_version":1,
    "payload":{
      "version":1,
      "exchanges":[{
        "id":"337f9038-8657-4d90-8fd3-6a5320740e4d",
        "captured_at":1790618401000,
        "source_timestamp":1000,
        "method":"GET",
        "url":"https://app.example.com/api/items",
        "status":500,
        "request_headers":{},
        "request_body":null,
        "response_headers":{"content-type":"application/json"},
        "response_body":"{\"error\":\"unavailable\"}"
      }]
    }
  }],
  "complete":false
}
```

Replace the sample session, event UUID, timestamps and data with actual captured values. `captured_at` is Unix milliseconds; `source_timestamp` is the event's session-relative milliseconds. QA enforces aggregate limits of 5,000 network exchanges/interactions and 10 MB per artifact. The other supported namespace/key pairs are `interaction/captured-interactions`, `session/metrics`, `session/identity`, and `session/capture-context`, all version 1. Do not guess their payloads or send fabricated data: use an existing compatible capture producer for those artifacts. Network capture above is enough to start verifying auxiliary forwarding.

When the session is finished and every auxiliary batch is accepted, send:

```json
{"session_url":"<the same real session URL>","auxiliary_data":[],"complete":true}
```

Implement durable server-side retries for this finalization request; browser unload alone is not reliable. Sessions are sealed after completion: later data returns 409. Completion requests goals/outcomes and friction/recovery reviews; a 200 acknowledges handoff, not successful analysis. Friction reviews can request reproduction journeys.

## Verify before declaring setup complete

- Run the target project's relevant tests/build and check that client bundles and logs contain no credentials. Verify the forwarding route rejects unauthenticated capture callers.
- Deploy using the project's normal workflow and permissions. If deployment requires user action, report that boundary and provide the concrete change for review.
- Submit one real accessible session with a redacted auxiliary event. Confirm the upload and completion responses, then poll `GET /api/v1/connection/reviews?reviewer=friction-and-recovery&page=0` and the `goals-and-outcomes` reviewer. Inspect the actual task state/result; empty results or an accepted request are not proof of a completed review. Use bounded polling/backoff and report outstanding work without repeatedly resubmitting completion.
- Daily reports are scheduled at 08:00 UTC for the previous day. The first eligible report covers the connection's setup day and runs the next morning. Read `GET /api/v1/connection/reports?day=YYYY-MM-DD`. The POST report endpoint only reads/awaits the scheduler; it does not force a report immediately. State when a report is not yet eligible instead of fabricating a result.

Report the account and QA project IDs, installed capture/server components, deployment status, first session/review evidence, and any remaining blockers. Never include API keys or secret callback URLs. Distinguish "configured", "review verified", and "first report pending" when appropriate. Do not claim the complete automatic fix factory is active.

For ongoing operation, read `/api/v1/skills/operate-self-healing/SKILL.md`. On 401, check which credential is being used and do not fall back to Subtext bearer authentication. On 429 retry with backoff. On 503 or `provisioning_pending`, preserve IDs and report the operator action needed. On 501, stop that unsupported operation; never invent a replacement provider API.
