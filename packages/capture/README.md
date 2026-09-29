# @replayio/self-healing-capture

Browser capture for FullStory sessions. This package owns the producers for network exchanges,
clicks, input/change values, paste text, keyboard events, user identity, activity counts and page/session
context. Install the package rather than copying a recorder into your app.

```sh
npm install @replayio/self-healing-capture @fullstory/browser
```

Call once in your production browser entry point, before rendering the application:

```ts
import { initCapture } from '@replayio/self-healing-capture'

export const capture = initCapture({
  orgId: '<your FullStory organization ID>',
  endpoint: '/api/self-healing/session', // same-origin server route
  onError: error => console.error('Session capture failed', error),
})

// When the application authenticates a user:
capture.identify({ id: user.id, name: user.name, email: user.email })
```

The package initializes FullStory itself. Remove the previous recorder/FullStory initialization
when migrating; do not install a second fetch wrapper. Do not call `initCapture` during SSR.
Repeated calls with the same org/endpoint return the existing controller. It captures fetch traffic
(browser-visible headers and bodies), not XMLHttpRequest or WebSockets. It preserves the existing
QA capture fields without introducing a redaction policy.

## Server route

The browser has no provider or account credentials. Its same-origin POST endpoint uses the app's
existing access controls and forwards the JSON body to Self Healing's
`POST /api/v1/connection/sessions`, adding `Authorization: Bearer <SELF_HEALING_API_KEY>` server-side.
Preserve the upstream response status so the recorder can detect failures.

For a standalone QA integration, configure the endpoint to the app's QA registration proxy instead.
The wire format is QA's existing `{session_url, auxiliary_data}` envelope. No Self Healing server or
package import is required in QA's ingestion/review implementation.

## Uploads and lifecycle

- Network, interaction and page-context artifacts use QA's version-1 namespace/key contracts.
  `session/capture-producer` additionally identifies this package and version. That is provenance,
  not authentication. QA recognizes network/interaction data by their artifact keys.
- The package batches whole events into UTF-8 JSON requests of at most 256 KiB. Uploads use the
  original fetch, so they do not capture themselves. Network errors, 429, server errors and
  Self Healing's `upload_busy` retry up to three attempts with identical bodies and event IDs.
- A single event larger than the request limit fails explicitly through `onError` and `flush()`;
  it is not truncated to fit. Bodies above 1 MB are null and the per-page/session network budget
  is 8 MB, matching the existing producer. Dropped counts are included in capture context.
  Network and interaction counts each stop at 5,000 entries per page/session.
- `await capture.flush()` waits for current in-flight captures and pending uploads. It rejects
  if FullStory has no session yet or any capture/upload has failed. There is no durable offline queue.
- `await capture.stop()` stops new capture, removes interaction listeners and flushes outstanding
  data. It does not stop FullStory recording or seal the server's session, and it cannot be restarted
  on the same page. `identify()` is a no-op after stopping.
- Session rollover preserves ownership of requests already in flight and resets producer counters.
  `captured_at` is absolute milliseconds; `source_timestamp` is page-relative milliseconds.

Finalization is a server operation. Once a whole session has ended and all pages' uploads succeeded,
send `{session_url, auxiliary_data: [], complete: true}` to Self Healing. A page flush or unload alone
cannot establish that a multi-page FullStory session has ended.

## Development and release

The source of truth is `packages/capture/src` in `replayio/self-healing`. Changes to producers belong
here. QA owns its independent ingestion schemas and compatibility tests, not another installer copy.

Publish locally with interactive npm authentication and 2FA:

```sh
npm ci
npm run capture:publish
```

Run from a terminal using Node 22.14+ and an npm account with publishing access to `@replayio`.
The script checks whether the manifest version exists, runs tests and the production build, packs
the tested output into a temporary directory, logs into npm if necessary, and publishes that exact
artifact. npm owns the browser login/security-key/2FA prompts. Credentials and OTPs are not script
arguments or repository secrets. Follow npm's authentication prompt when it appears.

Use `npm run capture:publish -- --dry-run` to test building and packaging without login or publication.
Registry errors fail the version check; already-published versions are skipped. After publishing,
the script checks that the version is visible on npm. If visibility verification fails, rerun: an
existing version is skipped, never overwritten. Temporary tarballs are removed when the script exits.

For later releases, update the package version and emitted producer metadata together, update the
root lockfile, and run the script from the reviewed revision. The producer test checks that metadata
matches the manifest. Installers receive updates through dependency upgrades and their lockfiles.
