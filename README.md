# Self Healing

Self Healing coordinates Fullstory/Subtext, Replay QA (formerly Loop QA), and a software factory through one REST API. The intended outcome is a stream of factory-authored PRs with verified fixes for real user problems, regular reports on user behavior, and QA for releases and PRs.

This repository follows Loop QA's React/Vite frontend, TypeScript Netlify functions, Neon Postgres persistence, `/api/v1` API, public OpenAPI document, and downloadable agent skills.

## Current scope

The connection API implements the first session-processing slice: one QA identity per provisioned account and one QA project per connected account, encrypted retained credentials, auxiliary upload forwarding, completion-triggered reviews, daily reports, and a scoped QA→Self Healing→Subtext gateway. It uses QA’s existing APIs and session-source callbacks, and requires runtime credentials; it has not been validated against a live customer Subtext account.

Start with [Obvious integration and rollout](docs/obvious-integration.md). The older `/projects/*` configuration API remains available, but its provider, fix-PR, event-stream and notification operations still return explicit `501 not_implemented`. This is not yet the complete self-healing PR factory.

## Capture package

[`@replayio/self-healing-capture`](packages/capture/README.md) is the source of truth for browser auxiliary-event capture. Installers use its API; QA consumes its versioned artifacts without importing it. See the package README for release instructions.

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

Provision with a **Subtext API key** using `POST /api/v1/accounts` (`provisionAccount`). It returns a **Self Healing account API key**. All subsequent API calls authenticate with that returned key, not the Subtext key. Each account has a dedicated QA service identity and token. Subtext and QA credentials stay encrypted server-side; QA receives only session-scoped proxy callbacks.

## Factory quick start

Copy the setup prompt from the landing page into Obvious or another coding agent:

> Read the API at https://self-healing.replay.io/api/v1 and follow its setup skill to set up Self Healing for this project.

`GET /api/v1` is the public starting point. It links to the setup skill, OpenAPI, and `GET /api/v1/skills`, the public skill catalog. Agents should follow the served setup skill to inspect the target project, provision credentials, implement capture forwarding, and verify a real review. No credentials are required to discover or read skills.

Set `SELF_HEALING_URL` to your deployed origin and `SELF_HEALING_API_KEY` to the account key returned by provisioning. Fetch these public resources first:

- `GET /api/v1/openapi.json` — schemas, operation IDs, and `x-implementation-status` for every operation.
- `GET /api/v1/skills/setup-self-healing/SKILL.md` — project setup.
- `GET /api/v1/skills/operate-self-healing/SKILL.md` — bug/fix/report loop and stopping conditions.
- `GET /api/v1/health` — liveness only, not database or provider readiness.

First POST `/api/v1/accounts` with JSON `{"subtext_api_key":"<Subtext key>"}`. Save the returned `api_key` in your factory's secret store. Repeating provisioning with the same validated Subtext key returns the same account/key.

```sh
curl --fail-with-body "$SELF_HEALING_URL/api/v1/connection" \
  -H "Authorization: Bearer $SELF_HEALING_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"My app","production_url":"https://app.example.com"}'
```

Use the same key for `/api/v1/connection/sessions`, `/reviews`, and `/reports`. See [the integration guide](docs/obvious-integration.md) for batching, completion, retries and report timing. All JSON write bodies are limited to 256 KiB.

The separate `/api/v1/projects` API stores local configuration. Its configuration PUTs replace the full document and do not activate provider work. Its project creation POST remains non-idempotent; use the connection API above to provision QA.

## Production deployment

GitHub Actions owns production deploys on merges to `main` and manual runs on `main`. Netlify automatic Git builds are skipped by `netlify.toml`. PRs run checks only; they cannot deploy or fetch production secrets. The workflow checks out main's current tip, runs tests/build before fetching secrets, synchronizes the explicit runtime configuration, migrates, deploys with `--no-build --prod`, and smoke-tests the immutable deployment URL (which works before custom DNS/TLS is ready).

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

Do not add a shared Subtext key or a Self Healing key map. Factories supply Subtext credentials only when provisioning accounts. The deployment copies `DATABASE_URL` and the explicit connection runtime settings (`SELF_HEALING_SECRET`, `LOOPQA_ADMIN_TOKEN`, optional `REPLAY_QA_URL` and `SELF_HEALING_URL`) into Netlify’s production Functions scope; deploy credentials and Infisical credentials stay in CI. Any retired key-map variable on this dedicated site is removed. Changing an Infisical database secret takes effect on the next successful deployment. The target site and database hostname are checked before any mutation; resource moves require updating `scripts/lib/deploy.ts` as well as secrets.

GitHub repository configuration:

- Secrets: `INFISICAL_MACHINE_IDENTITY_CLIENT_ID`, `INFISICAL_MACHINE_IDENTITY_CLIENT_SECRET`.
- Variables: `INFISICAL_PROJECT_SLUG`, `INFISICAL_ENV_SLUG` (exact Infisical slugs).
- The machine identity uses Universal Auth with read access to only this project's production secrets.

Once configured, merge the deployment workflow and run **Deploy production**. It will also run for subsequent main pushes. Public smoke checks verify HTML, OpenAPI, skills, health, and a 401 for requests without a Self Healing account key. These checks do not exercise paid QA or Subtext session processing. No live customer key is needed for deployment.

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

Connection processing also requires `SELF_HEALING_SECRET`, `LOOPQA_ADMIN_TOKEN`, and optionally `REPLAY_QA_URL` in production Infisical. See [rollout requirements](docs/obvious-integration.md#deployment-and-migration).
