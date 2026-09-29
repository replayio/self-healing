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

## Provider implementation roadmap

1. **Key lifecycle and project adoption.** Add explicit credential rotation that preserves the connection, and adoption of existing QA projects. The connection API already provisions one new QA project per account.
2. **Session monitoring.** Replay QA currently exposes `POST /api/v1/projects/{project_id}/integrations/fullstory`, returning installation instructions and rotating a project registration token. An adapter must preserve those one-time-token semantics, connect Subtext, and avoid accidental rotation on retries. Confirm the deployed provider contracts before implementing; no undocumented Subtext URLs are invented here.
3. **Ingestion and analysis.** Use durable background work for session synchronization and analysis; normalize evidence references and bugs without storing raw recordings. Persist provider cursors, deduplication keys, retries, and normalized errors.
4. **Factory coordination.** Implement durable append-ordered events and transactional, expiring bug claims. Multiple workers must not fix the same active claim. Return 409 for claim conflicts and 410 when an event cursor has expired. Specify retention before enabling the event stream.
5. **Fix and release QA.** Register factory-created PRs, queue QA against their preview URL and exact head SHA, and retain run evidence. Only a provider result may move a fix to `verified`. A new head invalidates the old verification. Verify webhook signatures (if webhooks are used), project ownership, repository/PR association, and delivery deduplication. Reconcile merges/closures with GitHub. Do not give clients a setter for `verified`.
6. **Reports.** Persist report jobs, period boundaries, behavior trends, friction points, source evidence, new bugs, and fix progress. Schedule daily/weekly generation from saved preferences. Deliver via configured email/Slack integrations with retries and observable delivery failures. The connection API configures QA’s daily scheduler. The connection report-destinations API configures email, Slack and Discord delivery through QA’s existing project settings. QA owns webhook storage and sends completed summaries; Self Healing does not persist those credentials or run a delivery worker.

Long-running provider work belongs in a durable queue/worker, not a Netlify request. Planned 202 responses require persisted jobs before returning success. Before enabling POST workflows, implement and document account-scoped idempotency keys, timeout/retry rules, and reconciliation. Use restricted provider endpoints; do not fetch arbitrary configuration URLs from the request handler.

## Remaining production work

This setup has QA and Subtext adapters, but no automatic session discovery, Self Healing background retry worker, automatic GitHub PR creation, account self-service, rate limiting, or production observability. The factory owns PR authoring, so automatic PR creation is not required inside this service. The Netlify site and Neon database are provisioned. The Infisical/GitHub machine-identity configuration remains an operator setup step. Health reports process liveness only.

## Dashboard

The dashboard uses the existing account-to-connection scope and dedicated QA credential. A factory exchanges its bearer key for a five-minute reusable launch link. The browser exchanges that ticket for a 24-hour Secure/HttpOnly cookie; cookie authentication is accepted only by the read-only dashboard routes, never by connection/configuration APIs or launch-link creation. See [dashboard.md](dashboard.md) for data definitions and rollout.

Migration `005_dashboard_sessions.sql` adds hashed, expiring launch/browser tokens. Each opening atomically checks the launch expiry and creates an independent browser token, leaving the launch link usable until its original expiry. This table stores authentication metadata only; dashboard queries read QA directly and do not persist reports or session contents.

## Factory bug pipeline

The operating skill uses account-key-only connection APIs to list/read bugs, record WONTFIX reasons through QA's existing bug update API, and rerun a bug's original saved journey/version against a preview through QA's test-run API. All bug, source run, journey and result reads check ownership against the authenticated connection. Dashboard cookies cannot use these routes.

Verification metadata (bug, PR, head SHA and preview URL) lives in the durable QA run goal. Self Healing adds no recording store or verification table. Run outcomes and recording references are projected from QA, never manufactured. The supplied head SHA is a factory assertion; the factory must verify the deployment's commit and inspect actual reproduction coverage. There is no setter for a verified verdict. Creation is not idempotent; after uncertain writes the factory must reconcile paginated runs before retrying. A bug without an available original journey is explicitly unverifiable through this endpoint.

The factory schedules polling (suggested every 15 minutes), coordinates one worker per bug, tracks PRs and verification run IDs, and follows the repository's merge policy. This does not implement the legacy claim/event/managed-fix contracts.
