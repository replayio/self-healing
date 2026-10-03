# @replayio/self-healing-capture

Temporary browser capture support for Self Healing while Subtext gains the accessors needed for
network exchanges, interactions, identity, metrics, and session context.

**Installation and integration instructions live in the
[Self Healing setup skill](https://self-healing.replay.io/api/v1/skills/setup-self-healing/SKILL.md).**
Follow that skill for account provisioning, browser initialization, server forwarding, automatic reviews,
and verification. This package is an implementation detail of that setup, not a separate installer.

QA consumes compatible versioned artifacts and recognizes the package/version provenance. Its
ingestion and review code does not import this package. When Subtext supplies the required accessors,
the Self Healing skills will describe the replacement and migration.

## Automatic local-state capture

Version 0.2.0 captures generic local state from Web Storage, script-visible cookies and IndexedDB, including redacted nested object structure. It requires no identity callback, auth-specific state or per-key configuration. Request headers are not exported. See the setup skill for behavior, limits and rollout; QA can retain the page-scoped artifacts without importing this package. Journey startup consumption is separate work.

Keep this producer generic: infer application prerequisites downstream from captured data rather than requiring embedding applications to maintain a parallel authentication state or enumerate keys.

## Development and release

The capture implementation lives in `packages/capture/src`. Change producers here and keep QA’s
independent ingestion schemas and compatibility tests compatible. Installation instructions belong
only in the Self Healing skills.

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
