---
name: setup-self-healing
description: Set up Self Healing by provisioning its API key, configuring deployment secrets and session capture, and handing off report settings, bug handling, and the status dashboard.
---

# Set up Self Healing for this project

Use this skill when the user asks to enable Self Healing in an application. Do the integration work in the current project; ask the user for a missing Subtext credential, deployment access, choices you cannot infer, and the optional site-QA choice below. Never ask the user to obtain or supply a Self Healing API key: provision it yourself through `POST /api/v1/accounts`, or retrieve the existing key from the project’s secret store. A user pasting the setup prompt is asking you to perform setup, not just explain the API.

To update an existing installation, follow [update-self-healing](../update-self-healing/SKILL.md), which applies the target package's bundled migrations to the dependency and application integration without repeating provisioning.

Self Healing’s dashboard is the user-facing destination for status, reports, bugs, and sessions. Use only that dashboard for status links; never show links to `qa.replay.io`, `app.fullstory.com`, or provider recording URLs, even when API responses contain them. The Subtext onboarding link below is only for obtaining the provisioning credential. Finish with a concise configuration summary and an **Open dashboard** option, as described at the end of this skill.

## Discover the service and inspect the project

Use the origin from which you downloaded this skill as `SELF_HEALING_URL`. Resolve every `/api/...` path below against that same origin. GET `/api/v1` for discovery, `/api/v1/skills` for available skills, and `/api/v1/openapi.json` for request/response schemas and implementation status. These are public; no key is needed to read them.

Inspect the project's framework, server routes, deployment configuration, secret manager, and existing Fullstory/capture integration. Reuse existing instrumentation rather than installing a second copy. Identify the production HTTPS URL and a readable project name. Locate any existing `SELF_HEALING_API_KEY` in the factory's durable secret store and the site's server-side secret manager without printing its value. Reuse the working key and securely configure it wherever access is missing. Do not create a new account when an existing working one is available.

Initial setup supports session ingestion, QA reviews, reproduction journeys requested by friction reviews, and daily behavior reports. Providing a key does not discover historical sessions or install browser capture. Automatic fix-PR orchestration, event streams, and other routes marked `planned` are not implemented; do not present saved configuration or a 501 response as working functionality.

## Ask whether to configure site QA

For now, running QA on the site is an optional part of setup. Ask the user: **“Would you like to configure QA testing for this site now, or skip it for now?”** Do not infer consent from the general request to set up Self Healing.

If they decline or defer, finish the session-capture, reporting, and dashboard setup with `start_exploration: false` when creating the connection. Do not start a base-site exploration or schedule additional site testing. Say that optional QA configuration was skipped and can be added later. Do not make it a setup blocker or keep asking during the same setup.

This choice controls initial base-site exploration and smoke-test runs. Session capture, session analysis, reports, and session-driven reproduction journeys stay enabled. Skipping base-site QA does not disable the self-healing bug/fix pipeline.

If they opt in, set `start_exploration: true` when creating the connection. Setup acceptance remains delivery of real session inputs; do not wait for the first bug or report to complete setup.

## Provision and store the account key

If the project has no Self Healing account key, obtain a Subtext API key with access to its Fullstory sessions. Direct the user to [Subtext](https://subtext.fullstory.com/) and its **Get Started** web flow to sign in or create the appropriate organization and obtain the API key. Neither the user nor the factory should run the Subtext wizard (`npx @subtextdev/subtext-wizard`), even if linked documentation suggests it. Receive the key through the user's secure secret input. Do not ask the user to paste it into source code or commit it. Never print credentials, return them in status reports, or embed them in client bundles.

### Resolve the Fullstory organization

Once the Subtext API key is available, the factory must resolve its organization ID itself before installing capture; do not require the user to supply an org ID. Make a server-side `GET https://api.fullstory.com/me` request with `Authorization: Basic <Subtext API key>` and read the nonempty `orgId` string from the JSON response. The key is used verbatim after `Basic`, without additional base64 encoding. For keys beginning with `eu1.`, use `https://api.eu1.fullstory.com/me`; `na1.` keys use the default host. For legacy keys without a region prefix, use the project's known Fullstory region, or the default host when no region is known. This is Fullstory's [API-key organization lookup](https://github.com/fullstorydev/subtext-wizard/blob/main/src/auth.ts), not a Self Healing route or an MCP `tools/list` call.

Use the returned `orgId` for capture's `orgId` option. If existing instrumentation has an organization ID, verify that it matches; resolve a mismatch before changing capture or provisioning a new account. If the lookup fails or returns no org ID, stop that setup step and report the status without credentials. Ask for a corrected key or region through the appropriate input when needed, rather than asking for an org ID or running the wizard. An existing working Self Healing integration with a configured capture org ID can reuse those settings without requesting the Subtext key again; if the org ID is missing, securely obtain the original Subtext key for this lookup without reprovisioning.

### Provision Self Healing

Before provisioning, identify a durable secret destination that future factory runs can read. Arrange to parse the response and save its `api_key` directly into that store without displaying the response body. Do not rely on chat history, tool output, a shell variable, or temporary process memory to retain the key.

POST `/api/v1/accounts` (`provisionAccount`) with `Content-Type: application/json` and this body, substituting the key securely:

```json
{"subtext_api_key":"<Subtext key>"}
```

No bearer key is required for this provisioning request: Self Healing validates the supplied Subtext key. The response contains `account_id` and `api_key`. **Immediately persist the returned `api_key` as `SELF_HEALING_API_KEY` before continuing setup.** It is a required long-lived credential for two consumers:

1. **The factory:** store the key in its durable secret store so later setup steps, resumed runs, bug/fix monitoring, and dashboard-link creation can authenticate.
2. **The deployed site:** configure that same key as a server-side runtime secret named `SELF_HEALING_API_KEY` for the capture forwarding route. Configure `SELF_HEALING_URL` to this service's origin for both consumers. A shared secret store is sufficient if both can access it; otherwise securely copy the same key into the site's deployment secret manager. Keep production credentials out of preview environments and browser/public environment variables. A local ignored environment file is sufficient only for local development.

After persisting the provisioned key, obtain access to the application’s actual deployment configuration. Use the existing deployment integration, CLI login, or secret manager access; if access is missing, ask the user to connect or authorize the deployment provider for the target application and environment. Then set `SELF_HEALING_API_KEY` and `SELF_HEALING_URL` yourself in its server runtime configuration. Merely adding placeholders to `.env.example`, setting local variables, or telling the user to configure them does not complete this step. Apply the provider’s required redeploy/restart through the project’s normal workflow so the running forwarding route receives the values. If access remains unavailable, retain the saved key and report the specific missing deployment access without asking the user for a Self Healing key.

Read the key back from the durable factory store without printing it and use that retrieved value for the connection request below. Confirm the site secret is configured for the intended server runtime before deployment; the real capture delivery check below verifies that the deployed route can use it. If secret storage or deployment access is unavailable, report that setup is blocked on credential persistence/configuration; do not mark setup complete. The application needs neither a QA token nor the service's infrastructure secrets.

Record `account_id`, `SELF_HEALING_URL`, and the secret's name/location in durable project or factory setup state so future runs know where to retrieve it. Store only the secret reference there, never the key value. Report that the factory key was saved and the site secret configured without exposing either value.

All subsequent **Self Healing** API calls use `Authorization: Bearer <SELF_HEALING_API_KEY>`, **not the Subtext key**. Each account has its own QA identity; Self Healing retains the encrypted provider credentials and mediates QA's session access. Once organization lookup and provisioning succeed, the application does not need to retain its Subtext key for these API calls.

If the provisioning response or returned key was lost, first check the factory and site secret stores. If neither has it, repeat `POST /api/v1/accounts` with the **same valid Subtext key** to recover the same account and API key, then persist and verify it as above. If the original Subtext key is unavailable, request it through secure secret input. An `account_id` alone cannot authenticate or recover the key. A different Subtext key creates another account even within the same Fullstory organization; do not substitute a new key to recover an existing integration. Account key rotation is not implemented. If provisioning returns `account_busy`, retry with backoff. If it returns `provisioning_pending`, stop provisioning and report that the service operator must reconcile an uncertain QA token issuance. Do not work around it by changing keys.

## Connect the application

GET `/api/v1/connection` using the account key. If it is connected, reuse its IDs and saved `start_exploration` value. This is a creation-time choice, not a switch to stop or restart existing QA work. A different value on an existing connection returns 409; do not create a replacement account to change it. If it returns `not_connected`, POST the same path with:

```json
{"name":"My application","production_url":"https://app.example.com","start_exploration":false}
```

Set `start_exploration` to the user’s choice: `false` to skip initial base-site QA, `true` to run it. Omission defaults to `false` for a new connection. Recover interrupted setup by repeating that exact POST. Save the chosen name, URL, and `start_exploration` value in project configuration so retries use identical values. The connection creates one QA project for the account and configures reviews and daily reports. Different settings return 409; do not create a replacement account to bypass this conflict. The older `/api/v1/projects` configuration API is not a substitute for connection provisioning.

A connected response confirms configuration; verify session delivery after installing capture. QA project creation starts initial exploration and smoke-test runs only when `start_exploration` is true. QA work requires credit capacity. Report quota or credit blocks to the user/service operator; do not promise free or unlimited work.

## Choose where daily reports should go

As part of setup, look for a suitable destination for this project's daily reports: an existing team Slack or Discord channel, or a user/team email address. Inspect the project's existing notification configuration, connected integrations, and server-side secret store. Reuse an established project reporting destination when its purpose and access are clear. Do not guess recipients from unrelated repository metadata or choose an arbitrary channel.

First GET `/api/v1/connection/report-destinations` with the account key. Preserve suitable destinations that are already configured. If none is suitable, the choice is ambiguous, or you need an email address or webhook credential, ask the user which email address or Slack/Discord channel should receive the reports. Use secure secret input for webhook URLs. If they decline delivery, leave it unconfigured and say so.

Configure the chosen destination with PATCH `/api/v1/connection/report-destinations`. Supply only the channels you are changing:

```json
{"email":{"addresses":["team@example.com"]}}
```

```json
{"slack":{"webhook_url":"<Slack incoming webhook URL for the chosen channel>"}}
```

```json
{"discord":{"webhook_url":"<Discord webhook URL for the chosen channel>"}}
```

Replace examples with actual project destinations. An existing Slack/Discord connection can help identify a channel, but this API needs that channel's webhook URL, not a bot token or channel ID. Omitted channels are preserved; setting a channel to `null` disables it. Multiple destinations are supported when appropriate. Email uses explicit addresses because the QA service account is not the user's mailbox; do not rely on QA `owner` or `members` recipients.

Confirm the saved settings with GET on the same path. Responses expose email recipients and `webhook_url_set` flags, never webhook URLs. Keep webhook credentials server-side and out of completion messages. QA sends completed daily reports to these destinations. Saving confirms configuration, not message delivery; do not wait for a report or send test messages as part of setup.

## Install the capture package

This skill owns the complete installation procedure. [`@replayio/self-healing-capture`](https://www.npmjs.com/package/@replayio/self-healing-capture) is a temporary implementation until Subtext provides all the accessors needed for auxiliary data. For now, install it; do not copy or generate a fetch wrapper. When those accessors are available, the replacement and migration instructions will live here. QA accepts the compatible data format through its APIs; it provides no application installer or session-configuration UI.

1. Inspect the application for an existing FullStory initialization or copied capture shim. Replace that shim with this package, preserving the existing organization ID and identity hook. There must be one recorder/FullStory initialization.
2. Use the organization ID resolved from the Subtext API key above (or the existing working integration's configured ID). Do not ask the user to look it up or invoke the Subtext wizard.
3. Install the package and its FullStory peer dependency:

```sh
npm install @replayio/self-healing-capture @fullstory/browser
```

If the package has not yet been published, report that release dependency; do not fall back to copying source. In the production browser entry point, before rendering (not during SSR):

```ts
import { initCapture } from '@replayio/self-healing-capture'

export const capture = initCapture({
  orgId: '<FULLSTORY_ORG_ID>',
  endpoint: '/api/self-healing/session',
  maxNetworkCaptureBytes: 1_000_000, // Optional; default maximum encoded network exchange size
  onError: error => console.error('Session capture failed', error),
})

// In the app's existing authentication callback:
capture.identify({ id: user.id, name: user.name, email: user.email })
```

The package owns network, interaction, identity, metrics and session-context generation, timestamps, session rollover, batching and retries. Preserve the app's existing capture policy. Do not add a generic field-redaction layer. Keep dependencies locked and upgrade the package to receive capture fixes. For an existing installation, read the target package's bundled `UPGRADING.md` and apply its versioned migrations to application-owned integration code as well as the dependency and lockfile. Do not repeat account provisioning.

### Capture behavior and lifecycle

The package captures fetch requests (browser-visible headers and bodies), clicks, input/change values, paste text, keyboard events, identity, activity counts, and page/session context. It does not capture XMLHttpRequest or WebSockets. Repeated initialization with the same organization, endpoint, and network capture limit reuses the controller.

- `capture.identify({id, name, email})` connects the app’s existing authentication hook to capture.
- `await capture.flush()` waits for in-flight captures and pending uploads. It rejects if FullStory has no session yet or a capture/upload failed.
- `await capture.stop()` stops new auxiliary capture, removes listeners, and flushes pending data. It does not stop FullStory. It cannot restart on that page; subsequent `identify()` calls do nothing.

Uploads use the original fetch so they do not capture themselves. The package retries network errors, 429s, server errors, and `upload_busy` up to three attempts with identical bodies and event IDs. Session rollover keeps ownership of requests already in flight. `captured_at` is Unix milliseconds and `source_timestamp` is page-relative milliseconds; installers do not generate these fields.

Capture retains the existing producer limits: network bodies have an 8 MB budget per page/session, and network and interaction counts each stop at 5,000 entries per page/session. Dropped counts appear in capture context. The package emits version-1 artifacts and `session/capture-producer` metadata identifying its name and version; this metadata is provenance, not authentication.

## Forward captures through Self Healing

Mount this handler at POST `/api/self-healing/session` using the application's server framework. For example, in a Next.js App Router project, place it in `app/api/self-healing/session/route.ts` and export `POST`. Use the application's existing server-side environment access if it does not use `process.env`.

```ts
export async function POST(request: Request): Promise<Response> {
  const body = await request.text()
  const response = await fetch(
    new URL('/api/v1/connection/sessions', process.env.SELF_HEALING_URL),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SELF_HEALING_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body,
    },
  )
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'Content-Type': 'application/json' },
  })
}
```

Use the app's existing access controls for its capture route. The forwarding handler above supplies the transport, not application-specific authentication. Store `SELF_HEALING_URL` and `SELF_HEALING_API_KEY` on the server. Do not put a QA token or Subtext key in this route or in the browser. Do not call QA's registration endpoint: Self Healing attaches the QA ingestion credential and session-source callback itself.

The producer sends `{session_url, auxiliary_data}`. Self Healing forwards those artifacts to QA. It does not transform or store the capture bodies locally.

`maxNetworkCaptureBytes` limits each network exchange to 1 MB (1,000,000 bytes) by default and accepts a positive safe integer. It counts the UTF-8 JSON encoding of both bodies, headers, and event metadata. Oversized exchanges are skipped and counted in capture context's `dropped_network_count`; later captures continue. The package derives its batch budget from this limit plus upload-envelope overhead, preserving whole events. Do not add a separate server-side request-size check. There is no event-fragment API or durable offline queue. Installers do not implement batching or modify captured event fields themselves.

## Verify session delivery and finish setup

Setup is complete when the deployed application's real session captures are successfully delivered to Self Healing. QA analysis and report generation are Self Healing's responsibility, not installer acceptance checks.

1. Run the target project's relevant tests/build and deploy using its normal workflow and permissions. If deployment requires user action, report that boundary and provide the concrete change for review.
2. Exercise a real session in the deployed application: make a fetch request, click or enter input, and exercise the existing identity hook if the app has one. Verify that the installed package uploads the resulting session URL and captured artifacts through the application's forwarding route. FullStory recording alone or a hand-crafted metadata-only upload does not verify this path.
3. Confirm that the forwarding route receives Self Healing's successful response from `POST /api/v1/connection/sessions`: HTTP 200 with `status: "stored"` and a nonempty `session_id`. The route must pass that response back to the package. Verify the uploads containing the exercised network and interaction events succeed, rather than checking only an initial metadata batch. Check that the account key stays server-side and the route uses the app's intended access controls.
4. Retain the test session URL as internal verification evidence; do not include the provider URL in the user-facing handoff. Summarize the deployed integration, Self Healing’s returned session ID and ingestion status, and the settings described below. If delivery fails, report the failed request's status/error and fix the capture or forwarding problem before declaring setup complete. Never include API keys or secret callback URLs.

Once delivery is verified, declare capture setup complete and present the completion summary and dashboard option below. Do not wait for the session to go quiet, poll QA reviewers, or wait for a daily report. Do not schedule those checks as setup follow-ups or hold the setup handoff for them. Continue forwarding capture batches normally; no completion request or recording shutdown is needed.

For ongoing self-healing bug triage and fixes, read `/api/v1/skills/operate-self-healing/SKILL.md`. On 401, check which credential is being used and do not fall back to Subtext bearer authentication. On 429 retry with backoff. On 503 or `provisioning_pending`, preserve IDs and report the operator action needed. On 501, stop that unsupported operation; never invent a replacement provider API.

## Summarize configuration and next steps

Before the handoff, read the saved report destinations and inspect the factory’s actual recurring-task configuration. For ongoing bug handling, follow [operate-self-healing](../operate-self-healing/SKILL.md) within the user’s authorized scope. Reuse an existing monitoring task; if ongoing operation is authorized, arrange the operating skill’s recurring bug triage (suggested every 15 minutes). If it is not authorized or scheduling is unavailable, offer it as a next step and explicitly say automatic fix work is not active. Do not silently equate capture setup with an active factory loop.

Give the user a concise summary of the actual configuration:

- **Capture:** identify the deployed application, confirm real session delivery with the returned session ID and `stored` status, and confirm the factory credential and deployment variables are saved without exposing their values. State whether optional base-site QA was enabled or skipped.
- **Daily reports:** explain that connection setup enables a daily report on behavior, friction, and bugs at **08:00 UTC**, covering the previous UTC day. The first eligible report covers the setup day and runs the following morning; generation and delivery may finish later. Name the saved email recipients or known Slack/Discord channel, or explicitly state delivery is unconfigured/declined/pending. Never show webhook URLs or guess a channel from a webhook-present flag. Completed reports are available in the Self Healing dashboard. These connection defaults are separate from the legacy project report-preference API; do not imply a custom schedule was applied through an unimplemented route.
- **New bugs:** explain that captured sessions are automatically analyzed after upload inactivity and findings appear in the dashboard. State whether factory monitoring is active and its actual cadence. When active, it investigates new bugs, dismisses invalid or unsuitable reports with reasons, writes fix PRs for appropriate defects, and verifies fixes against previews where available. Describe the project’s actual review/merge policy; do not promise automatic merging. If no recurring task exists, say bugs will appear in the dashboard but unattended triage and fix PRs are not yet configured. Mention concrete blockers.
- **Dashboard:** provide an **Open dashboard** option using the fresh launch link below, explaining that it shows self-healing status, daily reports, bugs and fix PRs, and captured sessions. Do not open it automatically unless the user asked to open it.

Use completed, pending, or unavailable accurately for each part. Do not wait for the first analysis, report, or bug to supply this summary.

## Offer the Self Healing dashboard

When setup is complete, call `POST /api/v1/dashboard-sessions` with the server-side account key and provide the returned `url` as a clickable **Open dashboard** option. If the user asks to open it, use the most appropriate available surface. Generate a fresh link for the handoff; if it expires before the user opens it, request another. Keep the account key server-side.

The returned URL can be opened directly in an iframe or embedded artifact. Links are reusable for seven days; each browser context receives a read-only session lasting seven days.

The dashboard has Overview, Bugs, Reports, and Sessions tabs. Overview shows bug counts and daily session activity; Bugs shows kinds, fix PRs, and bug reports within Self Healing; Reports lets the user cycle through daily reports; Sessions shows captured sessions by day with interactions and screenshots. No separate signup or QA project access is needed.
