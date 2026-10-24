---
name: update-self-healing
description: Update an existing application's Self Healing capture package and integration code using the target release's migrations, then verify session delivery.
---

# Update Self Healing in this project

Use this skill when asked to update an existing `@replayio/self-healing-capture` installation. Update the dependency and application-owned integration together. The original installation conversation is not required. For a project without an installation, use [setup-self-healing](../setup-self-healing/SKILL.md).

## Inspect the installation and target release

Locate the application's package manifest and lockfile, `initCapture` call, identity hook, configured same-origin capture endpoint, and server forwarding handler. Search for `@replayio/self-healing-capture`, `initCapture`, `SELF_HEALING_URL`, and `/api/v1/connection/sessions`. Follow the configured route rather than assuming the setup example's route name.

Record the exact installed version from the lockfile or resolved package, not only the manifest's version range. Use the requested target version, or resolve the latest stable published version when the user has not specified one. Do not assume the service deployment and npm release are synchronized.

Read **the target release's bundled `UPGRADING.md`** before changing application code. Obtain that exact published package with the application's package tooling (for example, `npm pack @replayio/self-healing-capture@<target-version>` in a temporary directory and inspect its `package/UPGRADING.md`). After installation it is also available at `node_modules/@replayio/self-healing-capture/UPGRADING.md`. The old installed guide may omit migrations needed for the target release. If the target release or its guide is unavailable, report the missing release instructions instead of inventing migrations or copying repository source into the application.

The bundled guide is the source of truth for versioned migrations and their verification steps. Apply every migration between the installed and target versions; if the installed version is unknown, inspect the integration against all migrations in that guide.

## Update the dependency and integration

Use the application's package manager to update the dependency and lockfile together to the chosen version. Reconcile application-owned initialization, identity integration, forwarding code, and capture-route body-parser settings using the guide. A dependency update cannot change an old forwarding handler.

Preserve the existing account, project connection, FullStory organization, credentials, identity hook, capture policy, and application access controls. Do not repeat provisioning, rotate credentials, or enable optional QA as part of an upgrade. Keep the Self Healing account key server-side; do not expose it in browser code or output.

For the complete integration contract, consult [setup-self-healing](../setup-self-healing/SKILL.md), using it to reconcile the installation rather than restarting setup. Preserve the application's configured `SELF_HEALING_URL`. Resolve `/api/v1/openapi.json` and other service requests against that configured origin; downloading this public skill from another deployment is not a reason to switch the application's service. Skills and API discovery are public; session forwarding uses the existing server-held account key.

## Verify and report

Run the application's relevant checks and all verification steps required by the applicable migrations. Verify capture through the actual application forwarding route, including any migration-specific payload-size and retry/drop checks from the guide.

Follow the application's normal review and deployment process. Once deployed, exercise a real browser session with a fetch request, an interaction, and the existing identity hook where applicable. Confirm that uploads containing the network and interaction artifacts reach Self Healing and that the forwarding route returns HTTP 200 with `status: "stored"` and a nonempty `session_id`. An initial metadata-only upload or a FullStory recording alone does not verify auxiliary capture. Check that credentials remain server-side and the route retains its access controls.

Report the previous and target package versions, application-code migrations, checks performed, and session delivery evidence without credentials or secret callback URLs. Distinguish local verification from deployed verification. If deployment or delivery verification is blocked, report the concrete remaining step; do not claim the deployed integration is updated. Do not wait for QA analysis, a bug, or a daily report to declare verified capture delivery.
