# Working in Self Healing

This is an initial Netlify/React/TypeScript service scaffold modeled on Loop QA.

- Read `README.md` and `docs/architecture.md` for what works and what is still a contract.
- Keep request/response schemas and route metadata in `src/api/contracts.ts`; OpenAPI and runtime validation share those definitions.
- Never return successful fake provider work. Keep unimplemented operations explicit 501s until their durable adapter exists.
- Every stored project/configuration operation must scope by the authenticated account, not a client-provided account ID.
- Keep factory/provider secrets server-side. Connections store only AES-GCM encrypted Subtext credentials, bound to their keyed fingerprint; never store plaintext keys. Do not add session recording data to the coordination database.
- Run relevant tests for changes. For the initial service, `npm test` covers the handler and real Postgres semantics through PGlite; `npm run build` checks TypeScript and the frontend.
- Keep deployment and database migration explicit. Preview environments must not share production databases or credentials.
