---
name: operate-self-healing
description: Operate Self Healing's session reviews and daily reports through its account-key-authenticated API.
---

Discover the API and all available skills at `/api/v1` and `/api/v1/skills` on this same origin. For a new project, first follow `/api/v1/skills/setup-self-healing/SKILL.md`.

Always call Self Healing with the account API key returned by provisionAccount, from a server-side secret store. The Subtext key is supplied only during provisioning. Never give either key to QA, the browser, or logs.

- GET `/api/v1/connection` to check provisioning. Retry the original POST after interrupted provisioning; do not invent a replacement key/project.
- POST `/api/v1/connection/sessions` for versioned auxiliary batches. QA automatically reviews sessions after 15 minutes without new uploads, checked every 15 minutes. Keep retries byte-equivalent where practical and preserve event IDs. No completion request is needed; the legacy `complete` field is ignored. See the setup skill for capture requirements.
- GET `/api/v1/connection/reviews?reviewer=friction-and-recovery&page=0` for QA results; `goals-and-outcomes` is also available. Inspect actual run state rather than treating submission as success.
- GET `/api/v1/connection/reports?day=YYYY-MM-DD` for a report and its sources. Omit the day for the latest report and day-navigation metadata. POST the same path with `day` to read or await yesterday’s scheduled daily report after 08:00 UTC. A `scheduled` response means waiting for QA’s scheduler, not that a task is already queued. This uses QA’s automatic schedule and does not replace an existing run on retry.
- Retry 409 busy uploads and 503 transport failures with the same body and backoff. QA may reject auxiliary changes once reproduction journey creation starts; surface that error rather than reporting a successful capture. Read error codes and stored results.

QA performs reviews and scheduled summarization, but all provider access goes through Self Healing. No session-discovery poller, historical backfill, email/Slack delivery, key-rotation endpoint, automatic fix-PR loop or durable factory event feed is implemented by this slice. The corresponding legacy project routes are explicit 501 contracts. Do not manufacture successful results.
