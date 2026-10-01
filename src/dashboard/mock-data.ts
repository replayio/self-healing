import type { z } from "zod";
import type {
  DashboardOverview,
  DashboardBugs,
  DashboardBugDetail,
  DashboardReports,
  DashboardSessions,
  DashboardSessionDetail,
  DashboardSessionSnapshot,
} from "../api/contracts";

type Overview = z.infer<typeof DashboardOverview>;
type Bugs = z.infer<typeof DashboardBugs>;
type BugDetail = z.infer<typeof DashboardBugDetail>;
type Reports = z.infer<typeof DashboardReports>;
type Sessions = z.infer<typeof DashboardSessions>;
type SessionDetail = z.infer<typeof DashboardSessionDetail>;
type SessionSnapshot = z.infer<typeof DashboardSessionSnapshot>;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

function timestamp(daysBack: number): string {
  return new Date(Date.now() - daysBack * 86400000).toISOString();
}

const overview: Overview = {
  name: "Obvious Issue Tracker",
  open_bugs: 7,
  fixed_bugs: 16,
  wontfix_bugs: 14,
  invalid_bugs: 2,
  closed_bugs: 32,
  new_open_bugs: 2,
  sessions: 20,
  sessions_24h: 20,
  serious_sessions_24h: 1,
  days: Array.from({ length: 30 }, (_, i) => {
    const day = daysAgo(29 - i);
    const sessions = i < 27 ? 0 : i === 27 ? 2 : i === 28 ? 4 : 20;
    const serious = i === 29 ? 1 : 0;
    return {
      day,
      sessions,
      reviewed_sessions: Math.min(sessions, sessions > 0 ? sessions - 1 : 0),
      bug_sessions: serious,
      serious_sessions: serious,
      both_sessions: 0,
    };
  }),
};

const mockBugs: Bugs["items"] = [
  {
    id: "bug-001",
    title: '"Backlog" status label in task card metadata renders at 1.78:1 contrast (10px muted gray text on white card)',
    severity: "medium",
    status: "open",
    discovered_at: timestamp(0),
    url: "/dashboard?tab=bugs&bug=bug-001",
    kind: "glitches",
    fix_prs: [{ repo_full_name: "replayio/obvious-issue-tracker", pr_number: 4, url: "https://github.com/replayio/obvious-issue-tracker/pull/4", state: null }],
  },
  {
    id: "bug-002",
    title: '16px "Bug" label chip in the new Issue modal renders red on pale red at 2.58:1 contrast (WCAG AA needs 4.5:1)',
    severity: "medium",
    status: "open",
    discovered_at: timestamp(1),
    url: "/dashboard?tab=bugs&bug=bug-002",
    kind: "glitches",
    fix_prs: [{ repo_full_name: "replayio/obvious-issue-tracker", pr_number: 53, url: "https://github.com/replayio/obvious-issue-tracker/pull/53", state: null }],
  },
  {
    id: "bug-003",
    title: '"Backlog" status label on Projects page rendered in pale gray #bac2c8 on a white card at 1.79:1 contrast (WCAG AA /alt)',
    severity: "medium",
    status: "open",
    discovered_at: timestamp(1),
    url: "/dashboard?tab=bugs&bug=bug-003",
    kind: "glitches",
    fix_prs: [{ repo_full_name: "replayio/obvious-issue-tracker", pr_number: 52, url: "https://github.com/replayio/obvious-issue-tracker/pull/52", state: null }],
  },
  {
    id: "bug-004",
    title: "788KB eagerly-loaded app bundle (index-q_DdPoMe.js) re-downloaded 5 times per session under max-age=0 caching and ships the whole TiptapProofMirror markdown editor with no code split",
    severity: "low",
    status: "open",
    discovered_at: timestamp(0),
    url: "/dashboard?tab=bugs&bug=bug-004",
    kind: "network-performance",
    fix_prs: [],
  },
  {
    id: "bug-005",
    title: '788KB eagerly-loaded app bundle (index-q9a85_9j.js) ships the entire issue-tracker app — including the Tiptap rich-text editor and its toolbar stack — with zero code splitting',
    severity: "low",
    status: "open",
    discovered_at: timestamp(0),
    url: "/dashboard?tab=bugs&bug=bug-005",
    kind: "network-performance",
    fix_prs: [{ repo_full_name: "replayio/obvious-issue-tracker", pr_number: 57, url: "https://github.com/replayio/obvious-issue-tracker/pull/57", state: null }],
  },
  {
    id: "bug-006",
    title: "Commerzial palette modal bundled eagerly in 789KB app script, re-downloaded on every navigation (cache-control: max-age=0)",
    severity: "low",
    status: "open",
    discovered_at: timestamp(1),
    url: "/dashboard?tab=bugs&bug=bug-006",
    kind: "network-performance",
    fix_prs: [{ repo_full_name: "replayio/obvious-issue-tracker", pr_number: 55, url: "https://github.com/replayio/obvious-issue-tracker/pull/55", state: null }, { repo_full_name: "replayio/obvious-issue-tracker", pr_number: 56, url: "https://github.com/replayio/obvious-issue-tracker/pull/56", state: null }],
  },
  {
    id: "bug-007",
    title: "Board view kanban columns lack ARIA landmarks, drag-and-drop has no keyboard alternative",
    severity: "low",
    status: "open",
    discovered_at: timestamp(2),
    url: "/dashboard?tab=bugs&bug=bug-007",
    kind: "accessibility",
    fix_prs: [],
  },
];

const closedBugs: Bugs["items"] = [
  {
    id: "bug-100",
    title: "Issue detail page crashed when description contained unescaped HTML entities",
    severity: "high",
    status: "fixed",
    discovered_at: timestamp(10),
    url: "/dashboard?tab=bugs&bug=bug-100",
    kind: "glitches",
    fix_prs: [{ repo_full_name: "replayio/obvious-issue-tracker", pr_number: 30, url: "https://github.com/replayio/obvious-issue-tracker/pull/30", state: "merged" }],
  },
  {
    id: "bug-101",
    title: "Priority dropdown truncated on mobile viewport widths below 375px",
    severity: "medium",
    status: "fixed",
    discovered_at: timestamp(14),
    url: "/dashboard?tab=bugs&bug=bug-101",
    kind: "user-experience",
    fix_prs: [{ repo_full_name: "replayio/obvious-issue-tracker", pr_number: 28, url: "https://github.com/replayio/obvious-issue-tracker/pull/28", state: "merged" }],
  },
];

const bugDetailMap: Record<string, BugDetail> = {
  "bug-001": {
    ...mockBugs[0]!,
    description: "The 'Backlog' status label uses 10px muted gray (#9CA3AF) text on a white (#FFFFFF) card background, resulting in a contrast ratio of only 1.78:1. WCAG 2.1 AA requires a minimum of 4.5:1 for normal text and 3:1 for large text (18px+ or 14px+ bold). This affects readability for all users and particularly impacts those with low vision.",
    reproduction_steps: "1. Navigate to the Board view\n2. Locate any card with 'Backlog' status\n3. Inspect the status label text color and background\n4. Calculate contrast ratio using any accessibility checker",
    expected_behavior: "Status labels should meet WCAG 2.1 AA contrast requirements (4.5:1 minimum for text this size).",
    actual_behavior: "Status label renders at 1.78:1 contrast, well below the 4.5:1 AA minimum.",
    notes: null,
    resolution: null,
    analysis: {
      impact: "Affects readability for all users; particularly impacts users with low vision or color deficiencies. Status labels are a primary navigation affordance in the board view.",
      root_cause: {
        text: "The status label component applies a hardcoded `text-gray-400` Tailwind class regardless of the background surface color, resulting in insufficient contrast on white cards.",
        evidence: [
          { tool: "readsource", params: { path: "src/components/StatusLabel.tsx", line: 24 }, result: 'className="text-gray-400 text-xs font-medium"' },
        ],
      },
      chain: [
        { text: "StatusLabel component renders with `text-gray-400` (#9CA3AF) on all surfaces" },
        { text: "Board view cards use white (#FFFFFF) background" },
        { text: "Contrast ratio 9CA3AF on FFFFFF = 1.78:1, fails WCAG AA 4.5:1" },
      ],
    },
  },
};

const reports: Reports = {
  older: daysAgo(2),
  newer: null,
  latest_attempt: null,
  run: {
    day: daysAgo(1),
    status: "completed",
    timezone: "UTC",
    sessions: 3,
    reviewed_sessions: 2,
    output: {
      overview: `Daily user behavior summary for ${daysAgo(1)} UTC. Coverage: 3 sessions, 2 reviewed. Both reviewed sessions came from the goals-and-outcomes reviewer, plus one friction-and-recovery session. This is a small sample, so findings below describe observed behavior rather than population-level trends. The dominant pattern was base tracking work in a Linear-style issue app: users logged on the app, opened the issues list, opened issue detail pages, and switched between List and Board views. Board view was exercised heavily, including Status filtering and Priority sorting. No new bugs were identified, and no prior summaries exist for comparison. One item warrants attention-up: an automatic background POST to a dashboard-healing-session was observed with no user action — an uncommitted observation, not a verified problem.`,
      findings: [
        {
          category: "User trends",
          title: "Issue tracking dominates sessions: detail views, list/board switching, and My Issues all used and completed",
          text: "Both reviewed sessions focused on the issue-tracking workflow: users opened issues from the list, viewed details, switched between List and Board layouts, and used the My Issues filter. All observed interactions completed without errors.",
          bugs: [],
        },
        {
          category: "Friction",
          title: "Board view with multi-filter workflows is a heavily exercised path (monitoring-level friction, no errors observed)",
          text: "The Board view was used extensively across sessions with Status and Priority filter combinations. While no errors were detected, the frequency and complexity of these interactions makes this a path worth monitoring for emerging issues.",
          bugs: [],
        },
        {
          category: "Friction",
          title: "Comment composition left incomplete: composer opened but no submitted comment was observed",
          text: "In one session, the comment composer was opened on an issue detail page, but no comment submission event was recorded. This could indicate a UX friction point where users abandon comments, or simply incomplete session coverage.",
          bugs: [],
        },
      ],
    },
    bugs: [],
  },
};

const sessions: Sessions = {
  sessions: [
    { session_id: "sess-abc123", session_url: "https://app.replay.io/sessions/sess-abc123", user_email: "wilson@obvious.dev", first_received_at: timestamp(0), last_received_at: timestamp(0) },
    { session_id: "sess-def456", session_url: "https://app.replay.io/sessions/sess-def456", user_email: "wilson@obvious.dev", first_received_at: timestamp(0), last_received_at: timestamp(0) },
    { session_id: "sess-ghi789", session_url: "https://app.replay.io/sessions/sess-ghi789", user_email: null, first_received_at: timestamp(1), last_received_at: timestamp(1) },
  ],
  page: 0,
  has_more: false,
};

const sessionDetail: SessionDetail = {
  session: sessions.sessions[0]!,
  timeline: "User opened the app, navigated to Issues, viewed issue detail, switched to Board view",
  interactions: [
    { timestamp: 1200, text: "Page loaded — Issues list" },
    { timestamp: 3400, text: "Clicked issue #42 — Detail view" },
    { timestamp: 8900, text: "Switched to Board view" },
    { timestamp: 12100, text: "Applied Status filter: Open" },
    { timestamp: 15600, text: "Dragged issue to In Progress column" },
  ],
};

const emptySnapshot: SessionSnapshot = {
  tree: "",
  images: [],
};

export function mockApi(path: string): unknown {
  if (path === "overview") return overview;

  if (path.startsWith("bugs")) {
    const params = new URLSearchParams(path.split("?")[1] ?? "");
    const status = params.get("status") ?? "open";
    const items = status === "open" ? mockBugs : closedBugs;
    return { items, total: items.length, page: 1, has_more: false } satisfies Bugs;
  }

  if (path.startsWith("bug?")) {
    const params = new URLSearchParams(path.split("?")[1] ?? "");
    const id = params.get("bug_id") ?? "";
    return bugDetailMap[id] ?? {
      ...mockBugs.find((b) => b.id === id) ?? mockBugs[0]!,
      description: "This bug was detected automatically by QA during a session review.",
      reproduction_steps: "1. Open the app\n2. Navigate to the affected area\n3. Observe the issue",
      expected_behavior: "The component should render correctly.",
      actual_behavior: "The component renders with the described defect.",
      notes: null,
      resolution: null,
      analysis: null,
    } satisfies BugDetail;
  }

  if (path.startsWith("reports")) return reports;

  if (path.startsWith("sessions?")) return sessions;

  if (path.startsWith("session?") && !path.startsWith("session-snapshot")) return sessionDetail;

  if (path.startsWith("session-snapshot")) return emptySnapshot;

  if (path === "redeem") return { ok: true as const };
  if (path === "logout") return { ok: true as const };

  return null;
}
