# Architecture and implementation boundaries

## Requirements

The [Self Healing Integration proposal](https://docs.google.com/document/d/1NCi4NSEXHnfIkmqi5AyMGn4ShvuQv75Yg8_q8s9ptU8/edit) calls for a single API/key, persistent project state outside the factory, Fullstory monitoring configured via Subtext, linked project context, release/PR QA, repository sightmaps, verified fix PRs, and recurring user-behavior reports. Teams can use only the pieces they need.

The initial service is a coordination layer. It does not become another session-recording store. The eventual direction is Fullstory-managed session/QA data with externally stored, optionally zero-data-retention QA. That is a target architecture, not a property of this initial implementation.

## Capture implementation

`packages/capture` contains the temporary `@replayio/self-healing-capture` implementation until Subtext supplies the required auxiliary accessors. Self Healing skills own all installation instructions and install it
and call `initCapture`; they do not embed browser producers. The package initializes FullStory,
produces version-1 auxiliary artifacts, batches uploads to a configurable same-origin route, and
reports failures through `onError`/`flush`. QA consumes the artifact contract independently and
can preserve optional `session/capture-producer` package/version provenance without importing the
package. The browser has no account or provider credential. `npm run capture:publish` tests, builds and publishes the package locally using interactive npm
login and 2FA. Existing registry versions are skipped; GitHub Actions does not publish releases.

## Ownership

| Component                       | Responsibility                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Software factory (e.g. Obvious) | GitHub app/repository access, context and sightmap maintenance, writing PRs, consuming verification results |
| Self Healing                    | One authenticated API, account isolation, desired project configuration, normalized provider contracts      |
| Subtext / Fullstory             | Account provisioning, session monitoring, behavior analysis, provider-owned user-session data               |
| Replay QA                       | Reproduction and root-cause evidence, release/preview testing, commit-specific fix verification             |
| User/team                       | Repository installation, account setup, report destination choice, review and merge decisions               |

## Implemented service

The static React/Vite site is published to `dist`; Netlify rewrites `/api/*` to one TypeScript function. Published skill files shadow the non-forced API rewrite. Unknown API paths return JSON 404s rather than an SPA fallback. No provider keys are included in the frontend bundle.

`GET /api/v1` provides public API discovery and the initial setup skill URL. `GET /api/v1/skills` lists the downloadable skills from the registry in `contracts.ts`; OpenAPI uses that same registry. The landing page provides a copyable prompt using its current origin so agents start with the intended deployment. Skills guide real setup and verification without treating pending provider work as success.

`contracts.ts` is the source for runtime input validation, route discovery, response types, and generated OpenAPI. Cross-field refinements (e.g. a PR run needs a PR URL) are also enforced at runtime. Provider-backed routes are marked `planned` in OpenAPI and will return 501 after authentication/input validation once identity resolution is available, without touching provider resources. Their success schemas describe the intended interface, not fake responses.

Neon stores project metadata and version-independent configuration documents. Every query includes the account ID derived from a bearer key; the composite configuration foreign key also enforces account/project ownership. Migrations are explicit operator actions. Configuration PUTs replace one document atomically and use last-write-wins semantics. A sightmap includes its source commit SHA. Report preferences use UTC and specify a weekday for weekly delivery.

`provisionAccount` validates a Subtext key and provisions a dedicated QA service identity using QA's generic admin token API. The coordination database stores the Subtext key and per-account QA token encrypted and bound to the keyed Subtext fingerprint. It returns a random Self Healing account key; subsequent requests resolve that key's hash locally, without authenticating with Subtext. The account key is also encrypted for recovery by repeated provisioning with the same validated Subtext key.

Each account owns its local configuration and one QA connection. The account's QA token is used for project setup, review requests, and reports. The deployment's privileged QA credential is used only for provisioning. Customer session payloads are forwarded to QA. Session-scoped callbacks authenticate QA to Self Healing, which retrieves the retained Subtext credential; QA never receives that credential.

See [the connection protocol](obvious-integration.md) for provisioning recovery, capture batching, upload receipts and automatic reviews, report scheduling and rollout. QA #4902 adds optional session-source callbacks; existing projects need no migration or configuration change. The retained encrypted credential is an intentional extension of the original reference-only secret design to support unattended processing.

## Account data-service interfaces

Account storage configuration and provider composition now have explicit boundaries: an encrypted
`AccountDataConfigStore`, an authenticated-account `AccountServiceResolver`, and a named `QAClient`.
Connection, dashboard, and pipeline code share the resolver instead of constructing their own clients.
The configuration API stores per-account database and artifact/recording endpoint credentials, but
external QA execution remains an explicit 501 with no managed-storage fallback. This does not stop
already queued QA work or establish ZDR. See [account data-service interfaces](account-data-services.md)
for the contract, migration 009, deployment limits, and the required QA-side adapters.

## Provider implementation roadmap

1. **Key lifecycle and project adoption.** Add explicit credential rotation that preserves the connection, and adoption of existing QA projects. The connection API already provisions one new QA project per account.
2. **Session monitoring.** Replay QA currently exposes `POST /api/v1/projects/{project_id}/integrations/fullstory`, returning installation instructions and rotating a project registration token. An adapter must preserve those one-time-token semantics, connect Subtext, and avoid accidental rotation on retries. Confirm the deployed provider contracts before implementing; no undocumented Subtext URLs are invented here.
3. **Ingestion and analysis.** Use durable background work for session synchronization and analysis; normalize evidence references and bugs without storing raw recordings. Persist provider cursors, deduplication keys, retries, and normalized errors.
4. **Factory coordination.** Implement durable append-ordered events and transactional, expiring bug claims. Multiple workers must not fix the same active claim. Return 409 for claim conflicts and 410 when an event cursor has expired. Specify retention before enabling the event stream.
5. **Fix and release QA.** Register factory-created PRs, queue QA against their preview URL and exact head SHA, and retain run evidence. Only a provider result may move a fix to `verified`. A new head invalidates the old verification. Verify webhook signatures (if webhooks are used), project ownership, repository/PR association, and delivery deduplication. Reconcile merges/closures with GitHub. Do not give clients a setter for `verified`.
6. **Reports.** Persist report jobs, period boundaries, behavior trends, friction points, source evidence, new bugs, and fix progress. Schedule daily/weekly generation from saved preferences. Deliver via configured email/Slack integrations with retries and observable delivery failures. The connection API configures QA’s daily scheduler. The connection report-destinations API configures email, Slack and Discord delivery through QA’s existing project settings. QA owns webhook storage and sends completed summaries; Self Healing does not persist those credentials or run a delivery worker.

Long-running provider work belongs in a durable queue/worker, not a Netlify request. Planned 202 responses require persisted jobs before returning success. Before enabling POST workflows, implement and document account-scoped idempotency keys, timeout/retry rules, and reconciliation. Use restricted provider endpoints; do not fetch arbitrary configuration URLs from the request handler.

## Remaining production work

This setup has QA and Subtext adapters, but no automatic session discovery, Self Healing background retry worker, automatic GitHub PR creation, account self-service, rate limiting, or comprehensive production observability. The factory owns PR authoring, so automatic PR creation is not required inside this service. The Netlify site and Neon database are provisioned. The Infisical/GitHub machine-identity configuration remains an operator setup step. Health reports process liveness only.

## Dashboard

The dashboard uses the existing account-to-connection scope and dedicated QA credential. A factory exchanges its bearer key for a seven-day reusable launch link. The browser exchanges that ticket for a seven-day Secure/HttpOnly cookie; cookie authentication is accepted only by the read-only dashboard routes, never by connection/configuration APIs or launch-link creation. See [dashboard.md](dashboard.md) for data definitions and rollout.

Migration `005_dashboard_sessions.sql` adds hashed, expiring launch/browser tokens. Each opening atomically checks the launch expiry and creates an independent browser token, leaving the launch link usable until its original expiry. This table stores authentication metadata only; dashboard queries read QA directly and do not persist reports or session contents.

## Factory bug pipeline

The operating skill uses account-key-only connection APIs to list/read bugs, record bug dispositions and their reasons through QA's existing bug update API, and rerun a bug's original saved journey/version against a preview through QA's test-run API. All bug, source run, journey and result reads check ownership against the authenticated connection. Dashboard cookies cannot use these routes.

PR associations are written directly by the factory through `POST /api/v1/connection/bugs/fix-prs`, once per bug. Migration `007_bug_fix_prs.sql` stores only account/project-scoped bug IDs and PR URLs, with idempotent inserts. Bug details, lists and dashboard reports merge these links with any QA-provided links. No QA GitHub integration is required; locally registered links have unknown PR state until a provider supplies it. Apply this migration before serving the updated bug APIs.

Verification metadata (bug, PR, head SHA and preview URL) lives in the durable QA run goal. Verification requests require a bug ID, persist the PR association, and pass the bug’s report, reproduction steps, expected/actual behavior and recording references in the QA task goal. A PR fixing multiple bugs gets one verification request per bug. Self Healing adds no recording store or verification table. Run outcomes and recording references are projected from QA, never manufactured. The supplied head SHA is a factory assertion; the factory must verify the deployment's commit and inspect actual reproduction coverage. There is no setter for a verified verdict. Creation is not idempotent; after uncertain writes the factory must reconcile paginated runs before retrying. A bug without an available original journey is explicitly unverifiable through this endpoint.

The factory schedules polling (suggested every 15 minutes), coordinates one worker per bug, tracks PRs and verification run IDs, and follows the repository's merge policy. This does not implement the legacy claim/event/managed-fix contracts.

## Optional initial site QA

Self Healing does not set a per-project QA credit budget. Ongoing session reviews and fix verification use QA's uncapped project default, subject to the account's available credits.

Connection creation stores `start_exploration` and forwards it to QA’s project-creation API. New connections default to false; an explicit true opts into initial exploration and smoke-test runs. Session ingestion, reviews, reports and session-driven reproductions remain active in either case. The option is creation-time configuration, not a project pause or restriction on explicitly requested work.

Migration `006_connection_exploration.sql` adds one boolean to existing connection metadata. Existing connections retain true to reflect the old provisioning behavior. Retries with an omitted choice preserve the saved value; an explicitly different choice returns 409 before provider work. Lost creation responses reconcile the original project instead of creating another. Deploy QA’s `start_exploration` support before this Self Healing version; an older QA deployment may ignore the field. No new secrets are required.

Factories update bug dispositions through `PATCH /api/v1/connection/bugs/{bug_id}`, with `status` (`open`, `fixed`, `wontfix`, or `invalid`) and a reason (required for wontfix/invalid). WONTFIX reasons use QA's dedicated field; other reasons append to QA notes. The endpoint checks account ownership, preserves existing notes, reads back the result, and skips completed writes on identical retries. Notes and status updates are separate provider writes: after a partial failure, read and retry the same request. PR association remains a separate operation. Fixed is a factory assertion after checking the fix landed using its GitHub access, not independent Self Healing verification. Closed-unmerged PRs must remain unresolved. Dashboard reads never mutate bug status. No migration or new credentials are needed.

## Durable service error diagnostics

Migration `008_service_errors.sql` adds an internal `service_errors` table. The API
awaits an insert for each unexpected HTTP 5xx response (excluding intentional 501
unimplemented routes), before returning the existing error envelope. Each occurrence
has the same request UUID returned in `X-Request-Id` and `error.request_id`, a database
timestamp, operation ID, error code/status, authenticated account ID when available,
and validated bug ID when available. Repeated failures remain separate records.
Failures before authentication have a null account; no client-supplied account ID is
used. Records have no automatic expiry.

QA bug/dashboard/pipeline schema failures retain up to 30 validation issue paths,
codes and received types, so an operator can identify a rejected field without the
original payload. QA HTTP failures retain the upstream status. Request bodies,
headers, cookies, URLs, credentials, raw provider responses, report/recording content,
and exception messages/stacks are not stored. Diagnostic details are not returned
to API clients. This is diagnostic metadata, not a session data store.

For a reported request ID, use an authorized database connection and a parameterized
query (parameters are the authenticated account ID and full request UUID):

```sql
SELECT * FROM service_errors WHERE account_id = $1 AND request_id = $2;
```

To investigate a bug over time:

```sql
SELECT * FROM service_errors
WHERE account_id = $1 AND bug_id = $2
ORDER BY occurred_at DESC;
```

The internal store's `find` method requires account scope; there is no public error
retrieval API. Operators can investigate pre-authentication failures directly by
request UUID. If the error database is unavailable, the handler preserves the
original response and emits `service_error_persistence_failed` with the same safe
metadata to runtime logs. That fallback cannot guarantee database durability during
a database outage. Apply the migration before deploying; this only captures future
errors and cannot recover previously discarded validation details.
