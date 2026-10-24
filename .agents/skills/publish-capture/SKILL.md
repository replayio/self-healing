---
name: publish-capture
description: Give concise publishing instructions for @replayio/self-healing-capture, or assist with its authorized release from the Self Healing repository.
---

# Publish the capture package

Read `packages/capture/package.json`, `scripts/publish-capture.ts`, and the release
section of `packages/capture/README.md` from the intended release revision. Confirm
the version from the manifest; do not carry a version number forward from an old
conversation. Use merged main unless the user specifies another reviewed revision.

## Giving instructions

Lead with one copy-pasteable shell command. Use the user's actual repository path,
properly shell-quoted. For a merged release that still needs to be pulled:

```sh
cd '<repository-path>' && git switch main && git pull --ff-only && npm ci && npm run capture:publish
```

If the terminal is already at the prepared release checkout, give only:

```sh
npm run capture:publish
```

State the Node requirement from the release docs (currently 22.14+) and that npm
will prompt for login/2FA with an account authorized to publish to `@replayio`.
That is normally the whole answer. Explain script internals or troubleshooting
only when relevant to the user's question. Keep CI/test infrastructure details in
development documentation rather than the user-facing publishing instructions.

The release script owns version-existence checks, verification, build, packing,
authentication, publication, and registry visibility checks. Use that entry point
rather than expanding its internals into manual commands. A request for instructions
means provide the command, not execute publication. Installing the release in a
customer application is a separate task.

## Assisting with an authorized release

Check for local changes before switching branches; preserve them. Run publication
in an interactive terminal so npm can handle its authentication prompts. Do not
request credentials in chat. For a requested rehearsal, use
`npm run capture:publish -- --dry-run`.

An already-published version is a successful no-op. If npm accepted publication but
registry visibility is pending, follow the script's printed verification command;
do not republish or bump the version merely because propagation is delayed.
Report the actual result and exact version. Merging the PR or deploying the service
does not establish npm publication.
