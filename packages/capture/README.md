# @replayio/self-healing-capture

Temporary browser capture support for Self Healing while Subtext gains the accessors needed for
network exchanges, interactions, identity, metrics, and session context.

**Installation and integration instructions live in the
[Self Healing setup skill](https://self-healing.replay.io/api/v1/skills/setup-self-healing/SKILL.md).**
Follow that skill for account provisioning, browser initialization, server forwarding, completion,
and verification. This package is an implementation detail of that setup, not a separate installer.

QA consumes compatible versioned artifacts and recognizes the package/version provenance. Its
ingestion and review code does not import this package. When Subtext supplies the required accessors,
the Self Healing skills will describe the replacement and migration.

## Development and release

The capture implementation lives in `packages/capture/src`. Change producers here and keep QA’s
independent ingestion schemas and compatibility tests compatible. Installation instructions belong
only in the Self Healing skills.

From the repository root:

```sh
npm ci
npm test
npm run build
npm pack --workspace @replayio/self-healing-capture --pack-destination /tmp
# After review, with npm publishing access to @replayio:
npm publish --workspace @replayio/self-healing-capture --access public
```

A PR/build alone does not publish to npm. Update the package version and emitted producer version together;
installers receive updates through normal dependency upgrades and their lockfiles.
