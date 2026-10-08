# Upgrading an existing Self Healing integration

This guide ships with `@replayio/self-healing-capture`. Coding agents should read it
when asked to update the package and reconcile the application integration as well
as its dependency. The original installation conversation is not required.

## Upgrade procedure

1. Read the installed package version and the version being installed. Use the
   application's package manager to update the dependency and lockfile together.
   Apply every migration below between those versions. If the old version is
   unknown, inspect the integration against all migrations.
2. Locate the existing `initCapture` call, identity hook, configured same-origin
   capture endpoint, and server forwarding handler. Search for
   `@replayio/self-healing-capture`, `initCapture`, `SELF_HEALING_URL`, and
   `/api/v1/connection/sessions`. Follow the actual configured endpoint rather than
   assuming the example route name.
3. Update application-owned installation code as described below. Keep the existing
   account, project connection, credentials, identity integration, and application
   access controls. Do not repeat provisioning or rotate credentials for an upgrade.
4. Run the application's relevant checks. Verify through its actual forwarding
   route that captured network and interaction artifacts reach Self Healing.
   Once deployed, exercise a real browser session and confirm HTTP 200 with
   `status: "stored"` and a nonempty `session_id`. An initial metadata-only upload
   or a FullStory recording alone does not verify auxiliary capture.
5. Report the dependency version, application-code changes, checks, and session
   delivery evidence. Distinguish local verification from deployed verification.
   Follow the application's normal review/deployment process; do not claim the
   deployed integration is updated until it has been verified.

For the current complete setup contract, see
https://self-healing.replay.io/api/v1/skills/setup-self-healing/SKILL.md.
Use it to reconcile the existing integration; do not treat an upgrade as a new setup.

## 0.1.4 — No cumulative network capture limit

The recorder no longer stops saving network exchanges after 8 MB or 5,000
requests. Uploaded exchanges are released from the capture queue; failed batches
retain their payloads and event IDs for retry. The configurable per-exchange
`maxNetworkCaptureBytes` limit is unchanged.

No application-code migration is required. Update the dependency and lockfile,
then verify a session with more than 8 MB of individually permitted exchanges
still delivers later requests. Previously dropped responses cannot be recovered
by upgrading; validation requires a new recording.

## 0.1.3 — Packaged upgrade instructions

No runtime integration changes beyond the migrations below. This release includes
this guide so upgrades can be performed without access to the installer conversation.

## 0.1.2 — One configurable limit per network exchange

- The embedder option is `maxNetworkCaptureBytes`, defaulting to 1,000,000 bytes.
  It measures the UTF-8 JSON encoding of each exchange, including both bodies,
  headers, and event metadata. Omit the option to use the default; preserve an
  intentional application-specific setting. If installation code uses the
  pre-release `maxBatchBytes` option, replace it with this per-exchange policy.
- Oversized exchanges are skipped and counted in `dropped_network_count`; later
  captures continue. Batching is internal and includes space for envelope overhead.
  A full-size exchange therefore produces an upload slightly larger than its limit.
- Earlier setup examples installed a **256 KiB request-size check in the app's
  forwarding handler**. Inspect for `256 * 1024`, `262144`, `413`, or the message
  `Capture exceeds Self Healing request limit` along the capture route. Remove that
  capture-specific check if present. Do not replace it with a 1 MB upload check.
  Inspect capture-route body-parser configuration for the same obsolete restriction;
  do not change unrelated application routes.
- Forward the original JSON body to `/api/v1/connection/sessions` using server-held
  Self Healing credentials and return the upstream status/body. Do not truncate
  capture fields, reimplement batching, or expose credentials in the browser.
- Verify an exchange with a body larger than 256 KiB but below the configured
  exchange limit (for example, 500 KB under the default) is actually delivered
  through the forwarding route with its body intact. Also verify a later small
  exchange after an oversized exchange, and check the dropped counter increases.

Updating the npm dependency cannot modify an application's existing forwarding
handler. These application-code migrations are part of the package upgrade.

## 0.1.1 — Capture decoding and retry fixes

No application-code migration is required. Keep capture initialization and the
existing identity hook. Failed uploads remain retryable; later batches continue.
Binary, invalid UTF-8, and NUL-containing bodies are represented as unavailable
while their exchange metadata remains captured.
