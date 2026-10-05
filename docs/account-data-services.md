# Account data-service interfaces

Self Healing owns account access configuration. QA owns execution and must eventually access all
customer data through the account's configured database, artifact, and recording services.
This change provides the Self Healing interfaces and encrypted configuration store; it does not
implement external execution in QA or claim zero data retention.

## Current behavior

Accounts without a data configuration retain their existing managed QA service identity and behavior.
`PUT /api/v1/account/data-config` selects external mode and stores access material. New Self Healing
connection, dashboard data, and bug-pipeline requests then return `501 external_qa_not_implemented`
before constructing a QA client or sending a provider request. There is no managed-storage fallback.
The deployment's reviewer-upgrade job skips externally configured accounts.

Configuration does **not** stop already queued or running QA jobs, revoke existing QA credentials or
session callbacks, migrate historical data, or remove old provider copies. It does not validate remote
connectivity, database schema readiness, or a provider's retention policy. Do not configure an active
customer as external expecting this release to establish ZDR. There is no API to revert external
accounts to managed storage.

Existing dashboard launch/redemption, authentication, configuration status, and legacy local project
configuration operations remain available. Dashboard data itself requires a supported QA adapter.

## Public configuration contract

All request/response schemas and route metadata live in `src/api/contracts.ts` and generate OpenAPI.
Both operations authenticate with the account's Self Healing bearer key; dashboard cookies do not
permit reading or writing data-service configuration. No request accepts an account ID.

- `GET /api/v1/account/data-config` returns mode, revision, and adapter availability only.
- `PUT /api/v1/account/data-config` replaces the complete configuration with optimistic revision checking.

The PUT envelope is `{ expected_revision, configuration }`. Initially `expected_revision` is `0`.
A changed configuration increments the revision; an identical retry returns the existing revision.
A stale writer that would replace a different current configuration receives `409 data_config_conflict`.
Clients must retain their configuration in their own server-side secret store to make later replacements.

The configuration describes:

| Service | Access material |
| --- | --- |
| Database | `adapter: "neon"` and `connection_string` |
| Artifacts | HTTPS `endpoint` and `credential` |
| Recording upload | HTTPS `endpoint` and `credential` |
| Recording API | HTTPS `endpoint` and `credential` |
| Recording MCP | HTTPS `endpoint` and `credential` |
| Recording dispatch | WSS `endpoint` and `credential` |

Recording entries are under `recordings.upload`, `.api`, `.mcp`, and `.dispatch`. Each has separate
credentials so upload, read, and processing permissions need not be shared. Endpoint credentials must
be in the credential field, not URL user information or query parameters. Endpoints are service access
descriptors, not signed object URLs. Storing a descriptor does not authorize arbitrary outbound fetches;
future adapters must verify destinations and enforce their provider's authentication protocol.

A stored external configuration returns:

```json
{"mode":"external","revision":1,"availability":"unsupported"}
```

An account without a configuration returns:

```json
{"mode":"managed","revision":0,"availability":"available"}
```

`available` describes the presence of the existing adapter, not a provider health check. Neither
response exposes endpoints, connection strings, or credentials. There is no public decrypt/read-secret
operation and no QA configuration-resolution HTTP endpoint yet.

## Service composition

`AccountDataConfigStore` in `src/api/data-config.ts` is the persistence interface:

- `status(accountId)` reads metadata without decrypting credentials.
- `read(accountId)` returns server-side access configuration to trusted adapter composition code.
- `put(accountId, input)` validates and atomically replaces encrypted access configuration.

The entire configuration is AES-GCM encrypted, including endpoint URLs. Its associated data binds it to
its account, credential purpose, format version, and keyed configuration fingerprint. The fingerprint
also includes the account identity. Migration `009_account_data_config.sql` stores only the ciphertext,
fingerprint, revision, and update timestamp; no customer content belongs in this table.

`AccountServiceResolver` in `src/api/account-services.ts` is the composition boundary. It accepts an
**already authenticated account ID** and returns the bound QA client, Subtext credential, and connection
service. It resolves the account mode before reading provider credentials. An absent configuration
means legacy managed mode; a database error never means an absent configuration. External mode is an
explicit unsupported adapter until the QA integration exists.

Connection, dashboard, and pipeline handlers all use this resolver. Deployment reviewer upgrades use
it too. Consumers depend on the named `QAClient` interface, not the return type of a client factory.
`createQAClient({ origin, token }, fetch)` accepts explicit service access. The environment-backed
`qaClient()` wrapper remains for existing composition and provisioning call sites. Requests are bound
to the validated origin, cannot escape `/api/` through path normalization, and reject redirects.
Session registration may use its own ingestion bearer without changing the account client's default
credential. No account-specific values are written to `process.env` or shared mutable global state.

## Next adapters

External QA execution should be implemented behind the resolver, with these contracts completed together:

1. A signed, account-bound QA request context and authenticated Self Healing configuration-resolution
   endpoint. Resolve account routing before QA's token lookup and request-recording middleware. A bare
   account header is insufficient; an old QA deployment must not silently ignore the new context.
2. A QA data context exposing its database query interface and artifact/recording services. Keep QA's
   existing task, review, and report transactions in the account database. Do not send database
   credentials to task workers.
3. An artifact adapter with upload initiation/finalization, read grants, and deletion. Route capture
   staging, screenshots, fixtures, task logs, and retained request-recording blobs through it. Store
   logical references instead of expiring URLs.
4. A recording adapter covering browser and driver uploads, API/MCP/dispatch access, processing,
   derived artifacts, playback, and deletion. A blob endpoint alone cannot replace Replay processing.
5. Account-bound task/worker/background credentials and account enumeration for schedulers. Carry
   context through asynchronous LLM calls, capture assembly, warming, spawning, and callbacks.
6. Explicit schema migration/readiness and retention verification. External readiness must reflect
   actual adapters and acceptance tests, not merely saved endpoints.

The QA-side changes belong behind those service interfaces. Individual business operations should not
select endpoints, inspect retention modes, resolve account secrets, or introduce fallback behavior.

## Deployment and verification

Apply migration 009 before serving this version. It is additive and repeatable. Previews need their own
database and credentials. No new deployment secret is required; the existing credential vault encrypts
the configuration. Deployment reviewer reconciliation excludes external accounts. Older releases do
not enforce the external-mode guard, so rolling back after external configuration requires an explicit
operator decision; ordinary rollback must not silently restore managed processing.

Tests use PGlite for encryption round trips, tenant isolation, copied-ciphertext rejection, concurrent
revision conflicts, idempotent retries, and HTTP authentication/validation. Resolver tests verify that
unsupported external accounts and unavailable configuration storage produce no QA requests. Existing
managed connection/dashboard/pipeline tests remain in place. These tests do not establish live QA or
recording-backend ZDR support.
