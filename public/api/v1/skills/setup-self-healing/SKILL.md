---
name: setup-self-healing
description: Configure a repository for the Self Healing API, including provider links, project context, sightmap, QA environments, and report preferences.
---

# Set up Self Healing

Use the user's configured `SELF_HEALING_URL` and server-side `SUBTEXT_API_KEY`. Read `GET /api/v1/openapi.json` at that origin before writing configuration. All nonpublic requests use `Authorization: Bearer <key>`. Do not put this key in a browser, a recording snippet, a URL, or a checked-in file.

This deployment is initially a scaffold. OpenAPI marks each operation `implemented` or `planned` with `x-implementation-status`. Planned endpoints return `501 not_implemented`. Do not retry a 501 or tell the user that monitoring/QA/reports are active merely because configuration was saved.

1. Establish the target repository, deployed app URL, and factory's GitHub access. The factory writes PRs; the service coordinates evidence and verification.
2. Use the user's Subtext account and key directly. Do not request, generate, or configure a separate Self Healing key. The service validates this key with Subtext and must resolve account/project identity there. Currently identity lookup is pending: a verified key returns `503 subtext_identity_unavailable`; stop setup data writes and report that specific missing adapter. Do not rotate a valid key to work around it. Ask for missing repository/deployment or report-destination information only when needed.
3. List existing projects before creating one. Register with `POST /api/v1/projects` using `name`, `repository_url`, `production_url`, and optional `default_branch`. Retain the returned project ID. After an ambiguous POST failure, reconcile against the project list before retrying.
4. Read then replace the appropriate project resources with `PUT /api/v1/projects/{project_id}/{resource}`. PUT replaces the whole resource; preserve existing values the user did not ask to change:
   - `integrations`: Subtext/Replay project IDs, Fullstory organization, resolved through the authenticated Subtext account. Never store provider secrets as context or configuration values.
   - `context`: product requirements and document links/content relevant to interpreting behavior.
   - `sightmap`: current repository commit SHA and file-purpose/route mappings.
   - `environments`: production/prerelease URLs, QA cadence, and PR-testing preferences.
   - `report-settings`: daily/weekly cadence, UTC hour/weekday, and the user's chosen email addresses or Slack channel/credential references.
5. Read back saved resources. Configuration persistence requires the Subtext identity adapter. Provider provisioning and scheduled work are not.
6. When OpenAPI advertises a working monitoring adapter, call the monitoring setup endpoint and follow its returned installation guide. Respect token-rotation semantics: never repeat setup automatically after an ambiguous result. Install only the returned browser-safe credentials, then check project readiness.

Report precisely which configuration is saved and which provider capabilities remain unavailable. For the ongoing loop, read `/api/v1/skills/operate-self-healing/SKILL.md` from the same origin.
