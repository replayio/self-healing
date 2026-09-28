---
name: operate-self-healing
description: Operate Self Healing's session reviews and daily reports through its Subtext-key-authenticated API.
---

Always call Self Healing with the customer's Subtext bearer key from a server-side secret store. Never give this key to QA, the browser, or logs.

- GET `/api/v1/connection` to check provisioning. Retry the original POST after interrupted provisioning; do not invent a replacement key/project.
- POST `/api/v1/connection/sessions` for versioned auxiliary batches, followed by a durable completion request after all uploads succeed. Keep retries byte-equivalent where practical and preserve event IDs. Completion seals the session. See the setup skill for capture requirements.
- GET `/api/v1/connection/reviews?reviewer=friction-and-recovery&page=0` for QA results; `goals-and-outcomes` is also available. Inspect actual run state rather than treating submission as success.
- GET `/api/v1/connection/reports?day=YYYY-MM-DD` for a report and its sources. Omit the day for the latest report and day-navigation metadata. POST the same path with `day` to request yesterday's daily report after 08:00 UTC. This uses QA's automatic, deduplicated schedule and does not replace an existing run on retry.
- Retry 409 busy uploads and 503 transport failures with the same body and backoff. A sealed-session conflict requires stopping new uploads, not blind retries. Read error codes and stored results.

QA performs reviews and scheduled summarization, but all provider access goes through Self Healing. No session-discovery poller, historical backfill, email/Slack delivery, key-rotation endpoint, automatic fix-PR loop or durable factory event feed is implemented by this slice. The corresponding legacy project routes are explicit 501 contracts. Do not manufacture successful results.
