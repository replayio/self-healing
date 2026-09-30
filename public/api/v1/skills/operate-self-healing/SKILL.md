---
name: operate-self-healing
description: Run the Self Healing pipeline: periodically triage user-session bugs, dismiss unsuitable reports with reasons, write fix PRs, and verify fixes with QA against preview deployments.
---

# Run the Self Healing pipeline

Use this skill after [setup-self-healing](../setup-self-healing/SKILL.md) has connected the project and confirmed that real session captures reach Self Healing. Read `/api/v1/openapi.json` on this same origin for request and response schemas. All calls below go to **Self Healing**, using `Authorization: Bearer <account API key>` and `Content-Type: application/json` for JSON bodies. Use the account key returned by provisioning, not the Subtext key. Keep it in the factory's secret store.

## Monitor and resume

Arrange a recurring task in the factory, suggested **every 15 minutes**. Each run should inspect new open bugs and resume existing fix work. Save the bug ID, disposition, PR URL, current head SHA, preview URL, and QA run IDs in the factory's persistent task state. Use one active worker per bug. Self Healing does not supply a claim/lease API; use the factory's own task coordination. If scheduling is unavailable, say so instead of claiming monitoring is active.

1. `GET /api/v1/connection` should return `status: "connected"`.
2. `GET /api/v1/connection/bugs?page=1` returns `items`, `total`, `page`, and `has_more`. Continue through all pages while `has_more` is true. Open includes reopened bugs. Do not use the legacy `/projects/.../bugs` routes; they are unimplemented.
3. For each report, `GET /api/v1/connection/bug?bug_id=<id>` returns its description, kind, severity, reproduction, expected/actual behavior, analysis, recording URLs, notes, and existing fix PRs.
4. Check existing `fix_prs`, the repository's PRs, and saved factory tasks before starting work. Resume a matching open PR instead of writing another. A closed or unrelated PR is not evidence that the bug is fixed.

Stay quiet when there is nothing actionable. Surface newly ready PRs, evidence-backed dispositions, and blockers that need the user's help. Review generation and daily reports run inside Self Healing; this factory loop consumes bugs rather than polling reviewer completion as a prerequisite.

## Decide whether to fix the report

Treat the report and proposed cause as claims to investigate. Compare the report with the source, intended product behavior, and recorded evidence. Inspect its recording with available Replay tools; reproduce or add a focused test where useful and permitted by the repository. Confirm both that there is a real defect and that changing this project is an appropriate fix.

For a false positive, a duplicate already covered by other work, expected behavior, or a real issue that should not be fixed, record **WONTFIX** with a concrete explanation and supporting evidence. For a duplicate, name the canonical bug and covering PR and explain why they cover this reproduction. If the product decision is unclear, ask the user; do not invent a reason to dismiss it. Missing access, an unavailable recording, a QA failure, or failure to reproduce alone is not evidence for WONTFIX.

`POST /api/v1/connection/bugs/wontfix`:

```json
{
  "bug_id": "<bug id>",
  "reason": "<why this report should not be fixed, with relevant evidence or canonical bug/PR links>"
}
```

The response is the updated bug. Check `status: "wontfix"` and `resolution` (the saved reason). On an uncertain response, read the bug before retrying; submitting the same reason again is safe. Do not close a different bug or the canonical duplicate target. Leave unresolved evidence or product questions open with a recorded factory blocker.

## Write a fix PR

For a valid, appropriate report, follow the target repository's development and PR instructions. Reproduce the defect, implement a focused fix, and run relevant tests. Explain the defect, change, and checks actually performed.

Associate the PR with every Self Healing bug it fixes by calling `POST /api/v1/connection/bugs/fix-prs` once per bug:

```json
{
  "bug_id": "<bug id>",
  "pr_url": "https://github.com/owner/repository/pull/123"
}
```

The response is the updated bug; confirm that `fix_prs` includes the PR URL. Association is idempotent, so repeating the request after an uncertain response is safe. The agent owns this association: PR-body references and the QA GitHub bot are not required. Save the bug/PR association in the factory task as well. Do not put an account key or dashboard launch ticket in the PR.

Keep the bug open while the fix awaits verification and landing. PR creation and a green build do not establish that the reported behavior is fixed. Do not set a bug to `fixed` just to trigger testing.

## Verify the preview with QA

Find the PR's successful preview deployment through the repository's deployment/check metadata. Confirm it serves the **current full PR head SHA**, is reachable by QA, and will stay available for the test. Prefer a deployment-specific URL so a later push cannot silently replace the code under test. Self Healing stores the supplied SHA as a reference; it cannot attest which commit a URL serves.

First read `GET /api/v1/connection/bug-verifications?bug_id=<id>&page=1` and follow `has_more`. Reuse a pending or completed run only when its `bug_id`, `pr_url`, `head_sha`, and `preview_url` match this revision. Otherwise start a run. Call this API for **each bug the PR fixes**, using that bug’s ID and the same current PR/head/preview references:

`POST /api/v1/connection/bug-verifications`:

```json
{
  "bug_id": "<bug id>",
  "pr_url": "https://github.com/owner/repository/pull/123",
  "head_sha": "<full 40-character PR head SHA>",
  "preview_url": "https://<deployment-specific preview host>"
}
```

This associates the PR with the specified bug and queues QA to rerun that bug's original saved reproduction against the preview, supplying its report, reproduction steps, expected/actual behavior, and recording references. It works without installing or configuring the QA GitHub bot. It returns `run_id`, the supplied references, and the actual QA run state. It does not return a verified verdict or mark the bug fixed. The reproduction must already exist: `409 verification_unavailable` means that QA cannot rerun this report through this endpoint.

Creation is **not idempotent**. After a timeout or transport failure, list verification runs and find the matching references before considering another POST. A request may have created work even if its response was lost. Use the factory's single worker for this bug to avoid simultaneous duplicate submissions. Save the returned `run_id` and use the GET endpoint above to follow that exact run; an empty page is not success, and `has_more` can be true even when that page contains no matching runs.

Before calling the fix verified:

- Wait for that run to finish. `status: "completed"` alone is insufficient: QA can complete a run that found a bug. Require `outcome_status: "passed"`, zero `bugs_found_count`, and inspect `recording_urls` to confirm the original failing behavior was exercised and now behaves correctly. Missing coverage or an unavailable recording remains an evidence gap.
- Treat `in-progress` as pending. A bug outcome needs another fix; infrastructure failure, incomplete, blocked, or cancelled runs require resolving the cause and a new verification attempt. Do not turn those states into WONTFIX.
- Check the PR's current head again. A new push requires a new preview and verification for that SHA. Never reuse an older run as evidence for changed code. Include the SHA, preview, run ID, outcome, and observed behavior in the PR's verification notes.

If there is no preview, the preview is inaccessible, or the original reproduction is unavailable, run the local/regression checks that are possible and state precisely what QA/preview verification remains unavailable. Document the alternative evidence and follow the repository’s readiness policy. If the remaining gap prevents establishing that the fix works, report that specific blocker. Do not claim QA verification that did not happen.

Follow the target repository's policies and the user's instructions for PR readiness, review, and merging. Report verification results and PR status to the user. Keep tracking the PR after handoff; a rejected, changed, or closed-unmerged PR may leave the bug needing work. Record merged PRs in the factory task and check the deployed behavior before taking further action. An open QA bug alone is not a reason to create another PR for an already-landed fix. This API does not mark a bug fixed on PR creation or a preview pass.

## Other operations and failures

- `GET /api/v1/connection/report-destinations` reads delivery settings. PATCH the same path to set `email: {addresses: [...]}`, `slack: {webhook_url: ...}`, or `discord: {webhook_url: ...}`. Omitted channels are preserved; `null` disables a channel. QA sends completed daily reports to those destinations. Webhook URLs stay server-side. Configuration is not proof of delivery.

- Session capture forwarding remains installed by the setup skill. Continue forwarding without sending a manual completion request.
- `GET /api/v1/connection/reports?day=YYYY-MM-DD` reads a daily report; omit `day` for the latest and navigation metadata. Reports are not prerequisites for triage or fixing a reported bug.
- `POST /api/v1/dashboard-sessions` returns a dashboard URL reusable for seven days. Each opening establishes an independent seven-day browser session. Open it for the user in the most appropriate available surface, or provide an **Open dashboard** link.
- Read error status and code. Authentication/configuration failures need resolution; retry transient reads with backoff. Do not treat empty data or failed calls as successful work. Never call QA with the customer's Subtext or Self Healing key: the service supplies its dedicated QA credential internally.
