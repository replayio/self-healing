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

## Open the dashboard

To let the user view this project's activity, call `POST /api/v1/dashboard-sessions` server-side with the Self Healing account bearer key (no body required). Return the response's `url` to the user as an **Open dashboard** link. Request it when the user wants to open the dashboard, rather than storing it in project configuration.

The link is single-use and expires after five minutes. Opening it establishes a read-only browser session for 24 hours. The account key stays in the factory's secret store; do not put it in a URL or browser code. If the link was already used or expired, create another. Opening a link for a different project switches the dashboard to that project's resources in that browser.

The dashboard has Overview, Bugs, and Reports tabs. Overview shows bug counts and daily session activity; Bugs links to existing QA bug reports; Reports lets the user cycle through daily reports. No separate signup is needed. The QA report links use QA's existing access rules.
