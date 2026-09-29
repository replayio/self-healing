# Factory dashboard

## Opening and authentication

Call `POST /api/v1/dashboard-sessions` with the existing Self Healing bearer key after connecting the project. No body is required. The response contains `url`, `expires_at`, and `session_ttl_seconds` (86400). A factory should display the returned URL as **Open dashboard** when requested, rather than saving a permanent link.

The five-minute, single-use launch ticket is in a URL fragment, so it is not sent in HTTP requests or referrers. The dashboard removes it from browser history before POSTing it to `/api/v1/dashboard/redeem`. That same-origin exchange atomically rotates its hash into a browser token and sets a Secure, HttpOnly, SameSite=Lax, host-only cookie. The 24-hour expiry is absolute and checked server-side; refreshing does not extend it. A used or expired link requires another factory call. A lost redemption response also requires a fresh link. Logout deletes the browser token. Opening a different project's link switches the current browser's dashboard session to that project.

Only dashboard GET routes accept this cookie; launch creation and existing factory APIs still require the bearer key. No provider keys or account API keys are sent to the browser. The launch ticket and browser token are capabilities and should not be published. There is no new signup or user login flow.

Migration `005_dashboard_sessions.sql` stores token hashes, account scope, kind and expiry. Expired rows are pruned when creating launch links. Deployment applies the migration through the existing pipeline. No new secrets or QA changes are required. `SELF_HEALING_URL` must be the HTTPS origin for that environment. A preview must use isolated credentials/database and its own origin. Local UI development can use fixtures; a full cookie exchange needs HTTPS.

## Data ownership and definitions

The dashboard reads existing QA APIs using the connection's dedicated QA token. It does not read Subtext directly or persist session/report contents. QA retains its own authorization rules for linked bug reports.

- Cards show all-time counts for the connected QA project. Open means `open` or `reopened`; closed means `fixed`, `wontfix`, `invalid`, or `pr-closed`. Unconfirmed (`judge-rejected`) reports are neither. New open bugs are currently open bugs whose `discovered_at` falls within the rolling last 24 hours.
- The graph covers the last 30 UTC dates, including today, bucketed by QA's `first_received_at`, the same session-start basis used by QA charts. It uses the paginated session-choice API, not the recent-100 session list. All sessions form the denominator, including unreviewed ones; review coverage is shown per day.
- A session has a detected bug when a QA reviewer context associates it with at least one bug other than `judge-rejected` or `invalid`. This includes fixed bugs: the chart records detection, not current backlog. QA's current reviewer-context semantics choose the latest successful review; this is not an immutable historical snapshot.
- A serious issue is a non-deleted friction-and-recovery observation with `attributes.impact === "blocked"`, using that reviewer's existing vocabulary. `delayed` and `minor` do not qualify. Repeated observations and associations across reviewers count a session only once.
- Each column's total height is its session count. Disjoint segments are no detected issue, serious only, bug only, and both. Hover or keyboard focus shows both percentages using the same total-session denominator. “No detected issue” does not establish that a session was problem-free.
- Bugs uses QA's paginated `status=open` filter, which includes reopened bugs. Links point at the existing QA report pages. All pages are accessible using Previous/Next.
- Reports reads the connection's daily summarizer. It shows QA's overview, new/duplicate bug lists and expandable findings, with bug evidence links. Reviewer identity, configuration and review panels are not exposed. Previous/Next follows QA's older/newer report dates; the date picker can request any completed day, and Latest restores the latest available report. Missing, queued and failed reports remain explicit.

QA provides paginated reads, not one dashboard aggregate. Overview collects those pages on demand. If QA fails, changes its response schema, or the reads exceed the request budget, the dashboard reports an error instead of returning partial counts. Concurrent upstream changes can affect a live view; these APIs do not offer a transactional snapshot. If project volume outgrows on-demand pagination, QA should expose a general-purpose aggregate API, independent of Self Healing.

## Reference implementation

Based on Loop QA at `c2f7c58d3762382eacbe05e924f33bcc51995dcc`: `OverviewSummary.tsx` stat cards; `ReviewerObservationChart.tsx` and `ProjectMethodChart.tsx` daily stacked chart conventions; `BugTable.tsx` report links; `SessionSummarizers.tsx` date navigation; `SessionSummaryResult.tsx` report sections. Self Healing uses its existing React/CSS stack and adds no frontend dependencies.
