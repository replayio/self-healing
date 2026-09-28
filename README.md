# Self Healing

Self Healing coordinates Fullstory/Subtext, Replay QA (formerly Loop QA), and a software factory through one REST API. The intended outcome is a stream of factory-authored PRs with verified fixes for real user problems, regular reports on user behavior, and QA for releases and PRs.

This repository follows Loop QA's React/Vite frontend, TypeScript Netlify functions, Neon Postgres persistence, `/api/v1` API, public OpenAPI document, and downloadable agent skills.

## Current scope

This is the initial **service scaffold**, not an operational self-healing pipeline.

- **Working:** landing page, public discovery, Subtext key validation, and Infisical-backed production deployment. The existing project/configuration storage handlers are tested behind an injected provider identity, but are not yet reachable in production: stable Subtext account/project resolution is pending.
- **Defined, not implemented:** Subtext account federation, monitoring provisioning, session analysis, bug discovery and claims, factory PR submission and verification, QA execution, event streams, behavior reports and delivery. After identity resolution is implemented, these endpoints will return `501 not_implemented`. Currently protected endpoints fail closed with `503 subtext_identity_unavailable` after successful key validation. They do not queue work or call providers.
- The caller supplies its own Subtext API key on each request; it is not stored or logged. Infrastructure secrets live in Infisical. Raw recordings stay with providers. This scaffold does not claim ZDR: context and project metadata are persisted in Postgres.

See [architecture and adapter boundaries](docs/architecture.md) for the next implementation steps.

## Local development

Use Node 22.13 or newer and npm. No provider account or database is needed to view the landing page, inspect OpenAPI, or run tests.

```sh
npm ci
npm run dev              # landing page only, http://localhost:5173
npm run dev:netlify      # landing page + REST API, http://localhost:8888
npm test                 # isolated PGlite Postgres tests; no external services
npm run build            # strict TypeScript check + production frontend
```

For local database development, copy `.env.example` to `.env`, set `DATABASE_URL`, and apply the bootstrap migration with `node --env-file=.env --import tsx scripts/migrate.ts`. Netlify Dev loads `.env` automatically.

The only client API credential is a **Subtext API key**, sent as `Authorization: Bearer <key>`. There is no local key registry or independently provisioned Self Healing account. Subtext is the authority for account/project identity and associated state. Local coordination records must be scoped to the provider-verified identity; neither a key hash nor a caller-provided account ID is an acceptable substitute.

Key verification follows the [official Subtext CLI](https://github.com/fullstorydev/subtext-cli/blob/main/internal/cli/auth.go): POST JSON-RPC `tools/list` to `https://api.fullstory.com/mcp/subtext` with the supplied bearer key. The current CLI verifies access but does not return stable account/project identity. Until the provider's identity lookup contract is confirmed and implemented, valid credentials receive `503 subtext_identity_unavailable` and no database access occurs. Invalid credentials receive 401; provider outages/malformed responses receive 503. The implementation does not fall back to a shared server key. Tests inject a provider identity resolver; production has no bypass.

## Factory quick start

Set `SELF_HEALING_URL` to your deployed origin and `SUBTEXT_API_KEY` to your Subtext key. Fetch these public resources first:

- `GET /api/v1/openapi.json` — schemas, operation IDs, and `x-implementation-status` for every operation.
- `GET /api/v1/skills/setup-self-healing/SKILL.md` — project setup.
- `GET /api/v1/skills/operate-self-healing/SKILL.md` — bug/fix/report loop and stopping conditions.
- `GET /api/v1/health` — liveness only, not database or provider readiness.

```sh
curl --fail-with-body "$SELF_HEALING_URL/api/v1/projects" \
  -H "Authorization: Bearer $SUBTEXT_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"My app","repository_url":"https://github.com/team/app","production_url":"https://app.example.com"}'
```

Once identity resolution is implemented, use the returned `id` in `/api/v1/projects/{project_id}`. `PUT` on `/integrations`, `/context`, `/sightmap`, `/environments`, or `/report-settings` replaces the entire configuration resource. Saving preferences does not activate integrations or scheduled jobs. All JSON write bodies reject unknown properties and are limited to 256 KiB.

Project lists use `limit` (1–100, default 25) and an exclusive UUID `cursor`; pass `next_cursor` into the next request. Ordering is by immutable project UUID, not creation time; concurrent new projects may appear before a saved cursor, so restart the listing when refreshing the inventory. The planned append-only events interface is the mechanism for reliable ongoing monitoring. POST requests have no idempotency guarantee yet: after an ambiguous timeout, reconcile before retrying. PUT configuration replacement is safe to retry.

## Production deployment

GitHub Actions owns production deploys on merges to `main` and manual runs on `main`. Netlify automatic Git builds are skipped by `netlify.toml`. PRs run checks only; they cannot deploy or fetch production secrets. The workflow checks out main's current tip, runs tests/build before fetching secrets, synchronizes the database secret, migrates, deploys with `--no-build --prod`, and smoke-tests the immutable deployment URL (which works before custom DNS/TLS is ready).

Provisioned resources:

- Netlify: `replay-self-healing`, site ID `48d9b72b-7125-484b-8082-1021cbc84456`, team `replay`.
- Domain: `self-healing.replay.io`; external CNAME target `replay-self-healing.netlify.app`.
- Neon: `self-healing`, project ID `tiny-tree-25762459`, Postgres 17 in `aws-us-west-2`.

Configure the Self Healing Infisical production environment with **only these required infrastructure values**:

| Name                   | Purpose                                     |
| ---------------------- | ------------------------------------------- |
| `NETLIFY_AUTH_TOKEN`   | CI deployment and environment configuration |
| `NETLIFY_ACCOUNT_SLUG` | `replay`                                    |
| `NETLIFY_SITE_ID`      | The provisioned site ID above               |
| `DATABASE_URL`         | The provisioned Neon database connection    |

Do not add a shared Subtext key or a Self Healing key map. Factories bring their own Subtext key. The deployment copies **only `DATABASE_URL`** into Netlify's production Functions scope; deploy credentials and Infisical credentials stay in CI. Any retired key-map variable on this dedicated site is removed. Changing an Infisical database secret takes effect on the next successful deployment. The target site and database hostname are checked before any mutation; resource moves require updating `scripts/lib/deploy.ts` as well as secrets.

GitHub repository configuration:

- Secrets: `INFISICAL_MACHINE_IDENTITY_CLIENT_ID`, `INFISICAL_MACHINE_IDENTITY_CLIENT_SECRET`.
- Variables: `INFISICAL_PROJECT_SLUG`, `INFISICAL_ENV_SLUG` (exact Infisical slugs).
- The machine identity uses Universal Auth with read access to only this project's production secrets.

Once configured, merge the deployment workflow and run **Deploy production**. It will also run for subsequent main pushes. Public smoke checks verify HTML, OpenAPI, skills, health, and a 401 for requests without a Subtext key. These checks do not claim that account lookup or provider automation works. No live customer key is needed for deployment.

The initial migration is repeatable; future migrations must remain compatible with the previous running release because migrations and publishing are not atomic. On failure, fix the error and rerun; do not blindly roll back schema changes. For frontend/function rollback, republish a known-good Netlify deployment after confirming schema compatibility. CLI/database output is kept out of CI logs to avoid credential leakage; inspect the Netlify dashboard for deployment diagnostics.

Preview deployment automation is intentionally absent. Add separate preview secrets and isolated Neon branches before enabling previews; production credentials must not be inherited by previews.

## Layout

- `src/main.tsx`, `src/style.css`: landing page and setup instructions.
- `src/api/contracts.ts`: shared Zod request/response schemas and route registry.
- `src/api/openapi.ts`: OpenAPI generated from the same contract definitions.
- `src/api/handler.ts`: authentication, routing, validation, and error envelopes.
- `src/api/store.ts`, `migrations/`: account-scoped Neon storage.
- `netlify/functions/api.ts`: Netlify entrypoint.
- `public/api/v1/skills/`: public factory instructions, copied into `dist` by Vite.
- `tests/`: HTTP-handler and Postgres integration coverage.
