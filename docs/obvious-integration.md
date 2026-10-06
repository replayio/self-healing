# Obvious → Self Healing → QA

## Connection

First provision an account:

```http
POST /api/v1/accounts
Content-Type: application/json

{"subtext_api_key":"<Subtext API key>"}
```

The `provisionAccount` operation validates the provider key and returns `{"account_id":"<uuid>","api_key":"sh_..."}`. Store `api_key` in Obvious's server-side secret store. Every subsequent call uses it as the bearer credential. Never send the Subtext key as authorization to connection/project/review/report endpoints.

Provisioning is idempotent per validated Subtext key: retries return the same account/key and dedicated QA identity. Different keys produce separate accounts. Possession of a valid Subtext key permits recovery of its account key through provisioning. Account key rotation/revocation is not implemented in this slice. A lost QA issuance response returns `provisioning_pending` on retry; it never blindly issues a second token.

```sh
curl "$SELF_HEALING_URL/api/v1/connection" \
  -H "Authorization: Bearer $SELF_HEALING_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"My app","production_url":"https://app.example.com"}'
```

Repeat this exact request to recover a timeout or provisioning failure. If QA has no matching project after a creation attempt, Self Healing returns `provisioning_pending` rather than risking a duplicate. An operator must confirm the original request did not create a project before clearing `create_attempted`; do not blindly reset it. Each provisioned account maps to one connection UUID and one QA project ID. Setup serializes requests in Self Healing and uses a stable marker in the QA project name to reconcile lost creation responses. Different settings for the same key return 409 rather than silently creating a second project. `GET /api/v1/connection` returns provisioning state. The QA project belongs to the account’s dedicated QA service identity and starts with a 20-credit project budget; its billing account must have capacity for work to run.

Self Healing validates Subtext only during provisioning. Later requests look up the Self Healing account key locally. Retained provider keys and QA tokens are encrypted with the root secret and bound to the keyed Subtext fingerprint. QA receives session-scoped callback URLs, never the provider key. Different Subtext keys produce different accounts even within the same Fullstory organization; key rotation preserving an account is not implemented.

## Capture and auxiliary events

All application installation instructions live in the [setup skill](../public/api/v1/skills/setup-self-healing/SKILL.md), including the temporary capture package and server forwarding. The package bridges missing Subtext accessors; QA independently consumes the artifact format and exposes configuration through APIs.

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

The client limits batches to 1 MB (1,000,000 bytes) including the UTF-8 encoded envelope. There is no separate per-body capture limit or server request-size check. The package splits arrays between whole events and retries identical batches internally. It reports a single oversized event as an error without silently truncating it. QA's existing schema and aggregate limits apply (5,000 network exchanges/interactions, 10 MB per artifact). Supported namespace/key pairs are `network/captured-exchanges`, `interaction/captured-interactions`, `session/metrics`, `session/identity`, and `session/capture-context`, all version 1. QA remains the artifact store; Self Healing owns the external interface and forwards validated uploads. The producer defines the captured fields; preserve the application's existing capture policy. This API adds no field-redaction requirement. This is not a zero-data-retention path.

QA's existing automatic reviewers are enabled with 100% sampling and a 15-minute upload quiet period. Its scheduler checks every 15 minutes and queues one automatic run per session/reviewer. Successful registrations update QA's last-received timestamp; identical uploads served from Self Healing's receipt cache do not postpone processing. Inactivity makes a session eligible for review, not permanently complete. New uploads remain accepted subject to QA's existing artifact and journey immutability rules. The legacy `complete` input is accepted but ignored; Self Healing no longer seals sessions or makes manual review requests during ingestion.

Goals/outcomes and friction/recovery reviews use the same scoped Subtext callbacks as before. Friction/recovery may request reproduction journeys. QA's normal credit/project capacity still applies.

This initial path is **push ingestion**: the app/proxy reports session URLs. Merely providing a key does not install browser capture or discover historical sessions. A Subtext session-discovery poller and backfill remain follow-up work.

## Reviews and daily reports

- `GET /api/v1/connection/reviews?reviewer=friction-and-recovery&page=0` (also `goals-and-outcomes`) returns QA's review results and task state.
- A daily summarizer is enabled at connection setup with a behavior/friction/bugs prompt, UTC timezone, and 08:00 schedule. QA's scheduler executes it over the previous day's data.
- `POST /api/v1/connection/reports` with `{"day":"YYYY-MM-DD"}` reads or awaits yesterday’s scheduled report after 08:00 UTC. It returns `existing`, `scheduled`, or `not_eligible` (a day before reporting was enabled). QA’s scheduler generates the report; this endpoint never calls the manual rerun API, which replaces existing reports. It does not promise that a `scheduled` report is already queued. The first eligible report covers the connection setup day and runs the next morning.
- `GET /api/v1/connection/reports?day=YYYY-MM-DD` reads a specific day, including processing status and evidence; omit `day` for the latest report and day-navigation metadata.

These result endpoints expose QA's native response envelopes. Email/Slack delivery, cross-day analytics, key rotation, retrospective discovery, and fix-PR orchestration are not implemented by this slice.

## Deployment and migration

QA must include session-source callback support (#4902). No application-specific setting or secret is required in QA, and existing QA projects retain their behavior.

Add `SELF_HEALING_SECRET` (32 random bytes, base64), `LOOPQA_ADMIN_TOKEN` (QA admin token authorized for `/api/admin-service-accounts`), and optionally `REPLAY_QA_URL` to Self Healing's production Infisical environment. Set `SELF_HEALING_URL` to the public HTTPS origin QA can reach; it defaults to `https://self-healing.replay.io`. Use `https://replay-self-healing.netlify.app` until custom DNS/TLS is ready. CI syncs these only to production Functions. Keep previews isolated. Back up the encryption secret: changing it changes fingerprints and makes stored credentials unreadable.

This change also requires QA #4915. The provisioning token is privileged and used exclusively to issue customer-specific QA tokens. Do not install the previously issued shared `service|self-healing` token: it is non-admin and cannot provision identities. The deploy removes the retired `REPLAY_QA_API_TOKEN` variable.

The deployment applies `004_accounts.sql` to store account metadata, encrypted credentials, authentication hashes and provisioning state. Existing Subtext-authenticated connections are not automatically adopted: provision a new account, then connect to create resources under its dedicated QA identity. Old Subtext bearer requests return 401. Existing session callbacks remain valid so already queued work can finish. Review any old QA resources separately before removing them.

If provisioning returns `provisioning_pending`, an operator must inspect QA identity `service|self-healing-<account UUID>`, ensure the original issuance has finished, and revoke any orphaned `Self Healing` token before clearing that account's `qa_issue_attempted` flag. Do not reset an in-flight attempt. The encrypted account key is not accepted until a QA token is durably stored.

The normal deployment also applies `003_session_coordination.sql`. It adds setup state, encrypted QA ingestion credentials, session references, upload digests/receipts, and scoped MCP handles. It does not store recording bodies or auxiliary payloads. Existing connection rows go through setup again to obtain an ingestion token and configure reviews/reports while retaining their QA project ID if present.

Self Healing calls QA's existing APIs:

- `POST /api/v1/projects` (also starts QA's normal initial exploration and uses billing capacity).
- `GET /api/v1/projects` for creation reconciliation.
- `POST /api/v1/projects/{id}/integrations/fullstory` for the project ingestion token. The adapter consumes QA’s structured `registration_token`. During rollout it also accepts the old installation-guide response, requiring exactly one unique `lqs_` token. Deploy Self Healing before QA removes that legacy response. Setup retries rotate it only while the connection is pending, before sessions are accepted.
- `POST /api/project-session/register` with that ingestion token, auxiliary data, and `source_callback_url`.
- `/api/project-session-reviewers` and `/api/project-session-summarizers` for settings, requests, and results.

Each callback is `POST /api/internal/sessions/{id}/subtext/{opaque_token}`. It authenticates through the URL, with no Authorization header from QA. The URL is a secret retained by QA for background processing. Its capability is restricted to its stored Fullstory session: `review-open` must name that session, subsequent calls must use a review client opened through the same registered session, and provider MCP session handles are encrypted and mapped to opaque local IDs. A context expires after 24 hours; HTTP 404 lets QA initialize a fresh one. Callback capabilities remain valid while the session and encryption secret exist; callback revocation/credential rotation APIs are not included.

Only MCP initialization, tool listing, and the four review tools reach the fixed Subtext endpoint. Redirects are disabled. JSON and SSE MCP envelopes are supported, with a 32 MiB response limit. Evidence is buffered transiently for validation and forwarded, never persisted here. Neither service should log callback URLs. QA #4902 omits credential-bearing registration/task-spec payloads from backend request recordings.

Requests are synchronous handoffs with durable metadata. The application retries failed setup and uploads. QA owns periodic review scheduling, duplicate prevention, quota checks, and daily report generation; there is no separate Self Healing scheduler or completion worker.

Acceptance before enabling customer traffic: connect a real key twice and see one QA project; upload a real session with captured network events; let uploads go quiet and obtain an automatically scheduled review; obtain a report for a completed day. Verify QA's worker endpoint points to Self Healing and no provider credential reaches QA. Automated tests use mocked providers and do not establish live Subtext compatibility or account billing readiness.

## Automatic-review rollout

Production deployment runs `scripts/enable-session-reviews.ts` after publishing and smoke checks. It
uses each provisioned account's encrypted QA credential to enable the two existing reviewers on ready
connections. Partial failures fail deployment and are safe to retry; already-enabled settings retain
QA's activation window. Repeating connection setup also reconciles review settings without creating a
project or rotating its ingestion token. No schema change or capture-package release is required.

QA's existing activation policy applies to sessions first registered after automatic reviews were
enabled. This rollout does not backfill sessions registered before that point; historical session
backfill is separate from automatic processing of newly captured sessions. Previously stored sealed
flags and completion receipts remain readable, but uploads no longer create or enforce local seals.

## Daily report destinations

Factories configure delivery through `GET` and `PATCH /api/v1/connection/report-destinations`, authenticated with the existing account key. The connected QA project is resolved server-side; clients cannot supply another account/project ID. PATCH accepts any combination of `email: {addresses: [...]}`, `slack: {webhook_url: ...}`, and `discord: {webhook_url: ...}`. Omitted channels are preserved, and `null` removes a channel. Email always maps to QA's custom recipient list, because the per-account QA service identity is not the user’s mailbox.

Self Healing calls QA's existing `GET /api/projects/{id}` and `PATCH /api/projects/{id}` with `action: "update-settings"` and only `summary_destinations`. QA owns storage and publication when a daily summary completes. Self Healing does not persist webhook URLs or send messages itself. Returned settings contain email recipients and webhook-present flags; full project responses and webhook credentials are never forwarded to clients.

The setup skill discovers suitable existing destinations and asks for missing choices or credentials. It verifies saved configuration without waiting for a report or sending test messages. Saving is not delivery verification. QA currently logs delivery failures; this API does not provide a durable delivery-status feed or retry queue. No new service secrets, database migrations, or QA changes are required.
