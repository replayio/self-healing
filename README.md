# Self Healing

Self Healing coordinates Fullstory/Subtext, Replay QA (formerly Loop QA), and a software factory through one REST API. The intended outcome is a stream of factory-authored PRs with verified fixes for real user problems, regular reports on user behavior, and QA for releases and PRs.

This repository follows Loop QA's React/Vite frontend, TypeScript Netlify functions, Neon Postgres persistence, `/api/v1` API, public OpenAPI document, and downloadable agent skills.

## Current scope

This is the initial **service scaffold**, not an operational self-healing pipeline.

- **Working:** landing page, public discovery, operator-provisioned account keys, durable project CRUD (create/read/update/list), and replacement/readback of provider links, context, repository sightmaps, QA environments, and report preferences.
- **Defined, not implemented:** Subtext account federation, monitoring provisioning, session analysis, bug discovery and claims, factory PR submission and verification, QA execution, event streams, behavior reports and delivery. These endpoints authenticate and validate requests, then return `501 not_implemented`. They do not queue work or call providers.
- Provider tokens are represented by secret-manager references, never stored as configuration values. Raw recordings stay with providers. This scaffold does not claim ZDR: context and project metadata are persisted in Postgres.

See [architecture and adapter boundaries](docs/architecture.md) for the next implementation steps.

## Local development

Use Node 22 and npm. No provider account or database is needed to view the landing page, inspect OpenAPI, or run tests.

```sh
npm ci
npm run dev              # landing page only, http://localhost:5173
npm run dev:netlify      # landing page + REST API, http://localhost:8888
npm test                 # isolated PGlite Postgres tests; no external services
npm run build            # strict TypeScript check + production frontend
```

For persistent API operations:

1. Create a Neon database (use a separate database/branch per environment).
2. Copy `.env.example` to `.env` and set `DATABASE_URL`.
3. Generate a key with `openssl rand -hex 32`. Set `SELF_HEALING_API_KEYS` to a JSON object mapping that key to a stable account ID, e.g. `{"<generated-key>":"my-team"}`. Keys must be at least 32 characters; account IDs contain letters, digits, `_`, or `-`.
4. Apply the bootstrap migration: `node --env-file=.env --import tsx scripts/migrate.ts`. `npm run db:migrate` also works when `DATABASE_URL` is already exported.
5. Run `npm run dev:netlify`. Netlify Dev loads `.env`. Give the key to the factory through its secret store; keep it out of browser code and Git.

Multiple keys may map to the same account for rotation. Remove an old key to revoke it. Different account IDs cannot read or write each other's projects. There is no self-service signup/key endpoint yet. The eventual consumer credential is a Subtext-backed account key; do not put a Subtext credential into this local key map as a substitute for federation.

## Factory quick start

Set `SELF_HEALING_URL` to your deployed origin and `SELF_HEALING_API_KEY` to the factory key. Fetch these public resources first:

- `GET /api/v1/openapi.json` — schemas, operation IDs, and `x-implementation-status` for every operation.
- `GET /api/v1/skills/setup-self-healing/SKILL.md` — project setup.
- `GET /api/v1/skills/operate-self-healing/SKILL.md` — bug/fix/report loop and stopping conditions.
- `GET /api/v1/health` — liveness only, not database or provider readiness.

```sh
curl --fail-with-body "$SELF_HEALING_URL/api/v1/projects" \
  -H "Authorization: Bearer $SELF_HEALING_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"My app","repository_url":"https://github.com/team/app","production_url":"https://app.example.com"}'
```

Use the returned `id` in `/api/v1/projects/{project_id}`. `PUT` on `/integrations`, `/context`, `/sightmap`, `/environments`, or `/report-settings` replaces the entire configuration resource. Saving preferences does not activate integrations or scheduled jobs. All JSON write bodies reject unknown properties and are limited to 256 KiB.

Project lists use `limit` (1–100, default 25) and an exclusive UUID `cursor`; pass `next_cursor` into the next request. Ordering is by immutable project UUID, not creation time; concurrent new projects may appear before a saved cursor, so restart the listing when refreshing the inventory. The planned append-only events interface is the mechanism for reliable ongoing monitoring. POST requests have no idempotency guarantee yet: after an ambiguous timeout, reconcile before retrying. PUT configuration replacement is safe to retry.

## Netlify deployment

1. Import `replayio/self-healing` in Netlify and use the checked-in `netlify.toml`. Build command: `npm run build`; publish directory: `dist`; functions directory: `netlify/functions`; Node: 22.
2. Configure server-side `DATABASE_URL` and `SELF_HEALING_API_KEYS` in the site's Functions environment. Never prefix secrets with `VITE_`.
3. Apply `001_initial.sql` to the deployment database using `npm run db:migrate` with that database URL exported. Migrations are intentionally not run in frontend builds or on cold starts.
4. Deploy and check health, OpenAPI, a published skill, and an authenticated project create/read round trip.
5. For deploy previews, use isolated database branches and preview keys. Do not expose production credentials to untrusted PR builds. An unconfigured deployment still serves the page/docs but returns `503` on authenticated routes.

GitHub Actions runs tests and the production build. Netlify's Git integration owns deploys and previews; no custom production deploy workflow or shared Loop QA infrastructure is needed. This PR does not create or deploy a Netlify site.

## Layout

- `src/main.tsx`, `src/style.css`: landing page and setup instructions.
- `src/api/contracts.ts`: shared Zod request/response schemas and route registry.
- `src/api/openapi.ts`: OpenAPI generated from the same contract definitions.
- `src/api/handler.ts`: authentication, routing, validation, and error envelopes.
- `src/api/store.ts`, `migrations/`: account-scoped Neon storage.
- `netlify/functions/api.ts`: Netlify entrypoint.
- `public/api/v1/skills/`: public factory instructions, copied into `dist` by Vite.
- `tests/`: HTTP-handler and Postgres integration coverage.
