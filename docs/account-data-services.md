# Account data-service interfaces

QA owns its account directory, authentication records, and ZDR settings in its main database.
All work for an external account belongs in that account's separate database and configured storage
services, including projects, tasks, queues, results, and recording metadata. Self Healing provisions
and updates settings through QA; it does not persist a second copy or serve configuration to QA workers.

## Configuration API

`GET/PUT /api/v1/account/data-config` authenticates a Self Healing account key and forwards to
QA's `GET/PUT /api/account-data-config` using that account's dedicated QA token. Neither API accepts
a client-selected account ID. QA derives its directory key from the authenticated user/service-account
identity (`service|self-healing-<uuid>`). Dashboard cookies cannot manage configuration.

PUT accepts `{ expected_revision, configuration }`. Configuration contains `mode: "external"`,
`retention: "zero"`, a `database` with `adapter: "neon"` and `connection_string`, an `artifacts`
service, and `recordings.upload`, `.api`, `.mcp`, and `.dispatch` services. Each service has an
`endpoint` and `credential`. Endpoints use HTTPS (WSS for dispatch), without URL credentials,
query strings or fragments. Artifacts cover non-recording blobs, including task logs and retained
request-recording data; their durable external adapter remains follow-up work.

QA encrypts the configuration with AES-GCM and binds it to the account and a keyed fingerprint.
It performs atomic revision checks: initial revision is 0, changed settings increment it, identical
retries preserve it, and conflicting stale replacements return 409. GET and PUT responses expose only
mode, retention policy for external accounts, revision, and adapter availability. They never return
service URLs or secrets. There is no revert-to-managed API.

`AccountDataConfigStore` in Self Healing is now a forwarding interface, with `status` and `put`.
Only QA's internal store has decrypted reads. A failed, malformed or unsupported QA configuration
response never falls back to a local configuration or managed work. `QAClient` supports explicit PUT
and pins requests to the configured QA origin with redirects disabled.

## Execution boundary and current limits

The Self Healing `AccountServiceResolver` checks QA's stored policy before composing work services.
External accounts return `501 external_qa_not_implemented`; deployment reviewer upgrades skip them.
Other configuration lookup failures stop processing. Connection, dashboard, and pipeline operations
share this resolver rather than selecting providers individually.

QA's companion PR provides a main-directory accessor, persisted configuration, and an internal service
resolver. Authentication remains in the main database. No request needs an account-routing token prefix
or a Self Healing configuration fetch. Future entrypoints authenticate first, resolve QA's settings,
then run account work inside the service scope. Schedulers must enumerate account identities from the
main directory and perform all task operations inside the account's database.

Saved `retention: "zero"` is a requested policy, not an enforcement attestation. Availability remains
`unsupported`: this does not stop existing QA jobs, migrate historical data, revoke old tokens or
callbacks, remove provider copies, or establish ZDR. Direct QA work entrypoints and workers still need
integration. Do not enable active ZDR accounts until that work is complete.

## Deployment

Deploy the QA configuration API and its main-database migration first. QA requires its own
`ACCOUNT_DATA_CONFIG_SECRET`, a base64-encoded 32-byte secret; preview credentials and databases must
be separate. Self Healing then uses the existing account-bound QA credentials. No new Self Healing
configuration table or secret is required. The previously proposed migration 009 has been removed
from this unmerged PR. If a development database applied it, its unused table needs an explicit operator
cleanup; no stored values are silently copied or dropped.

## Remaining work

- Integrate authenticated request, scheduled-job, worker, and callback contexts end to end. Keep
  identity/authentication/configuration in the main directory, and all account work in its separate DB.
- Implement durable artifact and recording adapters, including read/delete, upload/processing, and
  worker CLI paths. Migrate remaining direct recorder/provider access and audit caches/logs.
- Apply QA schemas to each account database, define revision changes for queued work, and verify
  two-account isolation and failure behavior before reporting external availability.

QA tests cover encrypted persistence, account binding, concurrent revision conflicts, and resolver
failure behavior. Self Healing tests cover authenticated forwarding, strict response validation,
redaction, upstream failures, and work being blocked by QA's external policy.

## Common execution boundaries

`requireAccountWork` is the single Self Healing admission policy used by account service resolution
and authenticated session callbacks. A callback verifies its token, derives the account from its stored
session, and checks current QA settings before decrypting the Subtext key or contacting the provider.
A policy lookup failure stops the callback. Existing callback URLs therefore do not bypass a newly
saved external policy. No account identity supplied by the callback caller controls routing.

QA's recorder-backed HTTP entry points now import one account gateway; ordinary SQL/storage clients
require its explicit context. Internal HTTP jobs use one signed dispatch transport and restore their
account at the gateway. This does not activate the container worker pool or external mutations.
