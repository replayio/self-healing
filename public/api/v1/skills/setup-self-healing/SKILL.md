---
name: setup-self-healing
description: Connect a Subtext key to Self Healing and configure session ingestion through a server-side proxy.
---

POST `/api/v1/accounts` with `{"subtext_api_key":"<Subtext key>"}`. Store the returned `api_key` in the factory's server-side secret store. Repeat with the same valid Subtext key to recover the same account/key. Use that Self Healing key as `Authorization: Bearer <key>` on every subsequent API call. Never put either key in browser code or forward the Subtext key to QA. Each account has a separate QA identity.

1. POST `/api/v1/connection` with `name` and `production_url`. Retry identical requests after transport failures; one account creates one QA project. GET the same path for status. A different key creates a different connection; rotation preserving identity is not yet supported.
2. Install Fullstory capture in the application. Configure a same-origin authenticated server proxy holding the Self Healing account key. Adapt QA's capture producers (`src/guidance/user-session/setup.md`) to upload to Self Healing's `/api/v1/connection/sessions` through this proxy, never directly to QA. Mask credentials/private input before transmission. Supplying a key does not install capture or discover historical sessions.
3. Upload `session_url`, `auxiliary_data`, and `complete:false`. Each version-1 artifact has `namespace`, `key`, `schema_version`, and `payload`. Supported pairs: `network/captured-exchanges`, `interaction/captured-interactions`, `session/metrics`, `session/identity`, `session/capture-context`. Match QA's versioned payload schemas. Use stable event IDs, absolute capture timestamps, and batches below 256 KiB. Wait for each batch to succeed; retry identical bodies on transient failures.
4. After all uploads finish, durably send `session_url`, `auxiliary_data:[]`, `complete:true` from the server. This seals the session and requests goals/outcomes and friction/recovery reviews. A 200 acknowledges handoff, not successful analysis. New data for sealed sessions is rejected.
5. Poll `/api/v1/connection/reviews` and `/api/v1/connection/reports`. Daily reporting uses UTC at 08:00 over the previous day's data. Provider work depends on QA billing capacity and can fail. Email/Slack delivery and automatic fix PRs remain unimplemented.

The service must have QA session-source callback support and its infrastructure secrets configured first. Read `/api/v1/openapi.json` for endpoints, and `docs/obvious-integration.md` in the repository for payload examples, deployment requirements, and migration limitations. Broader `/projects/*` provider contracts remain 501s: do not report monitoring, PR verification, or delivery as working merely because configuration was saved.
