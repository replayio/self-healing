# Obvious → Self Healing → QA

## Connection

Obvious's server supplies the user's Subtext API key. No customer-facing Self Healing key is issued.

```sh
curl "$SELF_HEALING_URL/api/v1/connection" \
  -H "Authorization: Bearer $SUBTEXT_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"My app","production_url":"https://app.example.com"}'
```

Repeat this exact request to recover a timeout or provisioning failure. If QA has no matching project after a creation attempt, Self Healing returns `provisioning_pending` rather than risking a duplicate. An operator must confirm the original request did not create a project before clearing `create_attempted`; do not blindly reset it. Each validated key maps to one connection UUID and one QA project ID. Setup serializes requests in Self Healing and uses a stable marker in the QA project name to reconcile lost creation responses. Different settings for the same key return 409 rather than silently creating a second project. `GET /api/v1/connection` returns provisioning state. The QA project belongs to the configured QA service account and starts with a 20-credit project budget; its billing account must have capacity for work to run.

Self Healing validates the key against Subtext on each customer request. A keyed fingerprint isolates that key's data. It stores an AES-256-GCM encrypted copy for background QA access, with the fingerprint as authenticated context. The root encryption secret stays in Infisical/Netlify Functions. QA receives only session-scoped callback URLs, never the customer's key. Keys for the same Fullstory organization still make separate connections. Key rotation preserving a connection is not implemented: don't substitute a new key expecting it to find the old project.

## Capture and auxiliary events

Install Fullstory in the user's app. Adapt QA's existing Fullstory capture shim so its **same-origin server proxy** forwards to `POST /api/v1/connection/sessions`. The proxy holds the Subtext key server-side. It must authenticate/authorize its app's capture requests and apply capture masking; never embed the Subtext key in browser code. See QA's `src/guidance/user-session/setup.md` for the capture producers. Use Self Healing as their destination, not QA's session registration route.

```json
{
  "session_url": "https://app.fullstory.com/ui/ORG/client-session/123:456",
  "auxiliary_data": [{
    "namespace": "network",
    "key": "captured-exchanges",
    "schema_version": 1,
    "payload": {
      "version": 1,
      "exchanges": [{
        "id": "337f9038-8657-4d90-8fd3-6a5320740e4d",
        "captured_at": 1790618401000,
        "source_timestamp": 1000,
        "method": "GET",
        "url": "https://app.example.com/api/items",
        "status": 500,
        "request_headers": {},
        "request_body": null,
        "response_headers": {"content-type":"application/json"},
        "response_body": "{\"error\":\"unavailable\"}"
      }]
    }
  }],
  "complete": false
}
```

Batches are limited to 256 KiB including the envelope. Preserve event UUIDs on retries; split large captures into ordered batches. QA's existing schema and aggregate limits apply (5,000 network exchanges/interactions, 10 MB per artifact). Supported namespace/key pairs are `network/captured-exchanges`, `interaction/captured-interactions`, `session/metrics`, `session/identity`, and `session/capture-context`, all version 1. QA remains the artifact store; Self Healing owns the external interface and forwards validated uploads. Upload producers must redact credentials, sensitive headers, and private fields from bodies, URLs, and input values before forwarding. This is not a zero-data-retention path.

After the session ends and all auxiliary batches have succeeded, send the same session URL with `auxiliary_data: []` and `complete: true`. The server proxy must persist and retry this finalization request; browser unload alone is not reliable. Self Healing seals the session locally and requests goals/outcomes and friction/recovery reviews through QA’s existing reviewer API. Automatic reviewer sampling is disabled for these projects so reviews start after completion; friction/recovery is configured to request journeys. Retry an identical batch or completion after transport errors; durable receipts recover the prior result. Different uploads to a sealed session return 409. Completion does not mean review success: review work is asynchronous and may be quota- or credit-blocked. Friction reviews can request reproduction journeys using QA's existing settings.

This initial path is **push ingestion**: the app/proxy reports session URLs. Merely providing a key does not install browser capture or discover historical sessions. A Subtext session-discovery poller and backfill remain follow-up work.

## Reviews and daily reports

- `GET /api/v1/connection/reviews?reviewer=friction-and-recovery&page=0` (also `goals-and-outcomes`) returns QA's review results and task state.
- A daily summarizer is enabled at connection setup with a behavior/friction/bugs prompt, UTC timezone, and 08:00 schedule. QA's scheduler executes it over the previous day's data.
- `POST /api/v1/connection/reports` with `{"day":"YYYY-MM-DD"}` reads or awaits yesterday’s scheduled report after 08:00 UTC. It returns `existing`, `scheduled`, or `not_eligible` (a day before reporting was enabled). QA’s scheduler generates the report; this endpoint never calls the manual rerun API, which replaces existing reports. It does not promise that a `scheduled` report is already queued. The first eligible report covers the connection setup day and runs the next morning.
- `GET /api/v1/connection/reports?day=YYYY-MM-DD` reads a specific day, including processing status and evidence; omit `day` for the latest report and day-navigation metadata.

These result endpoints expose QA's native response envelopes. Email/Slack delivery, cross-day analytics, key rotation, retrospective discovery, and fix-PR orchestration are not implemented by this slice.

## Deployment and migration

QA must include session-source callback support (#4902). No application-specific setting or secret is required in QA, and existing QA projects retain their behavior.

Add `SELF_HEALING_SECRET` (32 random bytes, base64), `REPLAY_QA_API_TOKEN` (private service account), and optionally `REPLAY_QA_URL` to Self Healing's production Infisical environment. Set `SELF_HEALING_URL` to the public HTTPS origin QA can reach; it defaults to `https://self-healing.replay.io`. Use `https://replay-self-healing.netlify.app` until custom DNS/TLS is ready. CI syncs these only to production Functions. Keep previews isolated. Back up the encryption secret: changing it changes fingerprints and makes stored credentials unreadable.

The normal deployment applies `003_session_coordination.sql`. It adds setup state, encrypted QA ingestion credentials, session references, upload digests/receipts, and scoped MCP handles. It does not store recording bodies or auxiliary payloads. Existing connection rows go through setup again to obtain an ingestion token and configure reviews/reports while retaining their QA project ID if present.

Self Healing calls QA's existing APIs:

- `POST /api/v1/projects` (also starts QA's normal initial exploration and uses billing capacity).
- `GET /api/v1/projects` for creation reconciliation.
- `POST /api/v1/projects/{id}/integrations/fullstory` for the project ingestion token. QA currently embeds the token in installation instructions; the adapter requires exactly one unique `lqs_` token. Setup retries rotate it only while the connection is pending, before sessions are accepted.
- `POST /api/project-session/register` with that ingestion token, auxiliary data, and `source_callback_url`.
- `/api/project-session-reviewers` and `/api/project-session-summarizers` for settings, requests, and results.

Each callback is `POST /api/internal/sessions/{id}/subtext/{opaque_token}`. It authenticates through the URL, with no Authorization header from QA. The URL is a secret retained by QA for background processing. Its capability is restricted to its stored Fullstory session: `review-open` must name that session, subsequent calls must use a review client opened through the same registered session, and provider MCP session handles are encrypted and mapped to opaque local IDs. A context expires after 24 hours; HTTP 404 lets QA initialize a fresh one. Callback capabilities remain valid while the session and encryption secret exist; callback revocation/credential rotation APIs are not included.

Only MCP initialization, tool listing, and the four review tools reach the fixed Subtext endpoint. Redirects are disabled. JSON and SSE MCP envelopes are supported, with a 32 MiB response limit. Evidence is buffered transiently for validation and forwarded, never persisted here. Neither service should log callback URLs. QA #4902 omits credential-bearing registration/task-spec payloads from backend request recordings.

Requests are synchronous handoffs with durable metadata. Obvious’s server must retry incomplete setup, uploads, and completion after failures; there is no Self Healing background retry worker. Review retries use a stable QA request UUID. Because QA reports both quota refusal and duplicate requests as `not_queued`, Self Healing checks that a review for the submitted session exists before acknowledging completion. Reports use QA’s existing daily scheduler.

Acceptance before enabling customer traffic: connect a real key twice and see one QA project; upload a real session with redacted network events; complete it and obtain a real review; obtain a report for a completed day. Verify QA's worker endpoint points to Self Healing and no provider credential reaches QA. Automated tests use mocked providers and do not establish live Subtext compatibility or account billing readiness.
