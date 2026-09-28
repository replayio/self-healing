# Architecture and implementation boundaries

## Requirements

The [Self Healing Integration proposal](https://docs.google.com/document/d/1NCi4NSEXHnfIkmqi5AyMGn4ShvuQv75Yg8_q8s9ptU8/edit) calls for a single API/key, persistent project state outside the factory, Fullstory monitoring configured via Subtext, linked project context, release/PR QA, repository sightmaps, verified fix PRs, and recurring user-behavior reports. Teams can use only the pieces they need.

The initial service is a coordination layer. It does not become another session-recording store. The eventual direction is Fullstory-managed session/QA data with externally stored, optionally zero-data-retention QA. That is a target architecture, not a property of this initial implementation.

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

`contracts.ts` is the source for runtime input validation, route discovery, response types, and generated OpenAPI. Cross-field refinements (e.g. a PR run needs a PR URL) are also enforced at runtime. Provider-backed routes are marked `planned` in OpenAPI and will return 501 after authentication/input validation once identity resolution is available, without touching provider resources. Their success schemas describe the intended interface, not fake responses.

Neon stores project metadata and version-independent configuration documents. Every query includes the account ID derived from a bearer key; the composite configuration foreign key also enforces account/project ownership. Migrations are explicit operator actions. Configuration PUTs replace one document atomically and use last-write-wins semantics. A sightmap includes its source commit SHA. Report preferences use UTC and specify a weekday for weekly delivery.

The caller's **Subtext API key is the only client credential**. The server validates it using the official Subtext CLI's `tools/list` protocol. It is used only for that request and is never persisted or logged. Account/project identity and linked state must be resolved through Subtext. A local key-to-account registry, key-hash tenant ID, or independent Self Healing account is not part of this architecture.

`tools/list` proves access but does not identify the owning account/project. The stable identity contract remains unconfirmed, so the production authenticator fails closed with `503 subtext_identity_unavailable` after key verification. The storage handlers are tested with an injected resolver but are not enabled in production. This deliberately prevents cross-account access without inventing a provider endpoint or trusting client identity claims. The next adapter must also enforce any project-level scope of a Subtext key, rather than granting all organization projects based on an organization ID alone.

Production secrets flow Infisical → GitHub Actions → Netlify Functions. Only `DATABASE_URL` is synchronized into Netlify, under the production context and Functions scope. No Subtext key is required in deployment configuration. GitHub Actions deploys verified main code; migrations run immediately before publishing. Netlify's automatic Git builds are disabled to give CI sole ownership of releases.

## Provider implementation roadmap

1. **Account and project linking.** Implement the provider-verified account/project identity resolver and state lookup. Key validation already uses the official Subtext protocol. Bind both provider project IDs to the authenticated account; validate ownership before activating a link. Do not accept a caller-supplied provider ID as proof of access.
2. **Session monitoring.** Replay QA currently exposes `POST /api/v1/projects/{project_id}/integrations/fullstory`, returning installation instructions and rotating a project registration token. An adapter must preserve those one-time-token semantics, connect Subtext, and avoid accidental rotation on retries. Confirm the deployed provider contracts before implementing; no undocumented Subtext URLs are invented here.
3. **Ingestion and analysis.** Use durable background work for session synchronization and analysis; normalize evidence references and bugs without storing raw recordings. Persist provider cursors, deduplication keys, retries, and normalized errors.
4. **Factory coordination.** Implement durable append-ordered events and transactional, expiring bug claims. Multiple workers must not fix the same active claim. Return 409 for claim conflicts and 410 when an event cursor has expired. Specify retention before enabling the event stream.
5. **Fix and release QA.** Register factory-created PRs, queue QA against their preview URL and exact head SHA, and retain run evidence. Only a provider result may move a fix to `verified`. A new head invalidates the old verification. Verify webhook signatures (if webhooks are used), project ownership, repository/PR association, and delivery deduplication. Reconcile merges/closures with GitHub. Do not give clients a setter for `verified`.
6. **Reports.** Persist report jobs, period boundaries, behavior trends, friction points, source evidence, new bugs, and fix progress. Schedule daily/weekly generation from saved preferences. Deliver via configured email/Slack integrations with retries and observable delivery failures. No scheduler or delivery worker runs in this scaffold.

Long-running provider work belongs in a durable queue/worker, not a Netlify request. Planned 202 responses require persisted jobs before returning success. Before enabling POST workflows, implement and document account-scoped idempotency keys, timeout/retry rules, and reconciliation. Use restricted provider endpoints; do not fetch arbitrary configuration URLs from the request handler.

## Remaining production work

This setup has no provider adapters, background workers, delivery integrations, automatic GitHub PR creation, account self-service, rate limiting, or production observability. The factory owns PR authoring, so automatic PR creation is not required inside this service. The Netlify site and Neon database are provisioned. The Infisical/GitHub machine-identity configuration remains an operator setup step. Health reports process liveness only.
