import { useEffect, useState, useRef, type ReactNode } from "react";
import { z } from "zod";
import {
  DashboardOverview,
  DashboardDay,
  DashboardBugs,
  DashboardBugDetail,
  DashboardEvidence,
  DashboardReports,
  DashboardSessions,
  DashboardSessionDetail,
  DashboardSessionSnapshot,
  type DashboardBug,
} from "../api/contracts";
import "./dashboard.css";
import { screenshotQueue } from "./screenshot-queue";
import { dashboardTicket } from "./launch-link";

type Overview = z.infer<typeof DashboardOverview>;
type Bug = z.infer<typeof DashboardBug>;
type Reports = z.infer<typeof DashboardReports>;
const tabs = ["overview", "reports", "bugs", "sessions"] as const;
type Tab = (typeof tabs)[number];
const iconPaths = {
  overview: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  bugs: (
    <>
      <rect x="7" y="7" width="10" height="14" rx="5" />
      <path d="M9 7V5a3 3 0 0 1 6 0v2M3 9l4 2m10 0 4-2M3 15h4m10 0h4M5 21l3-3m8 0 3 3M12 8v12" />
    </>
  ),
  reports: (
    <>
      <path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8m-8 4h6" />
    </>
  ),
  left: <path d="m14 6-6 6 6 6" />,
  right: <path d="m10 6 6 6-6 6" />,
  refresh: (
    <>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M5 8a8 8 0 0 1 14-3l1 7M4 12l1 7a8 8 0 0 0 14-3" />
    </>
  ),
  sessions: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8m-4-4v4m-3-10 6 3-6 3z" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
};
function Icon({ name }: { name: keyof typeof iconPaths }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {iconPaths[name]}
    </svg>
  );
}
const Failure = z.object({
  error: z.object({
    message: z.string(),
    code: z.string().optional(),
    request_id: z.string().optional(),
  }),
});
class DashboardError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}
const MOCK_MODE = import.meta.env.DEV && !window.location.hash.includes("ticket=");

async function api(path: string, signal?: AbortSignal, body?: unknown) {
  if (MOCK_MODE) {
    const { mockApi } = await import("./mock-data");
    const result = mockApi(path);
    if (result !== null) return result;
  }
  const response = await fetch(`/api/v1/dashboard/${path}`, {
    credentials: "same-origin",
    signal,
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = Failure.safeParse(value).data?.error;
    throw new DashboardError(
      error?.message ?? "Self Healing did not respond correctly. Try again.",
      error?.code,
      error?.request_id,
    );
  }
  return value;
}
// One exchange per page load, including React StrictMode's repeated mount effects.
let initialization: Promise<void> | undefined;
function initialize() {
  if (!initialization) {
    if (MOCK_MODE) {
      initialization = Promise.resolve();
    } else {
      const ticket = dashboardTicket(window.location.hash);
      initialization = ticket
        ? api("redeem", undefined, { ticket }).then(() => {
            window.history.replaceState(
              null,
              "",
              window.location.pathname + window.location.search,
            );
          })
        : Promise.resolve();
    }
  }
  return initialization;
}
// Moving between tabs revisits the same endpoints, and a cold overview costs several seconds of QA
// pagination. Keep the last payload per path so a revisit paints immediately and the refetch only
// has to replace what is already on screen. Snapshots stay out: they are base64 images.
const cache = new Map<string, unknown>();
const CACHE_LIMIT = 24;
const cacheable = (path: string) => !path.startsWith("session-snapshot?");
function remember(path: string, value: unknown) {
  if (!cacheable(path)) return;
  cache.delete(path);
  cache.set(path, value);
  for (const key of cache.keys()) {
    if (cache.size <= CACHE_LIMIT) break;
    cache.delete(key);
  }
}
function clearDashboardCache() {
  cache.clear();
}
function useData<T>(path: string, schema: z.ZodType<T>) {
  const [state, setState] = useState<{
    path: string;
    data?: T;
    error?: string;
  }>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const cached = cache.get(path);
    // Show the previous payload while revalidating; the fetch below replaces it when it lands.
    setState({
      path,
      data: cached === undefined ? undefined : schema.safeParse(cached).data,
    });
    (path.startsWith("session-snapshot?")
      ? screenshotQueue(() => api(path, controller.signal), controller.signal)
      : api(path, controller.signal)
    )
      .then((value) => {
        const data = schema.parse(value);
        remember(path, value);
        return data;
      })
      .then((data) => {
        if (!controller.signal.aborted) setState({ path, data });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState({
            path,
            error:
              error instanceof z.ZodError
                ? "QA returned unexpected dashboard data."
                : String(error.message),
          });
      });
    return () => controller.abort();
  }, [path, revision, schema]);
  return {
    ...(state?.path === path ? state : {}),
    retry: () => setRevision((n) => n + 1),
  };
}
function LoadState({
  error,
  retry,
  children,
}: {
  error?: string;
  retry: () => void;
  children: ReactNode;
}) {
  return error ? (
    <div className="dh-state" role="alert">
      <p>{error}</p>
      <button onClick={retry}>Retry</button>
    </div>
  ) : (
    <div className="dh-state" role="status">
      {children}
    </div>
  );
}
const count = (n: number) => n.toLocaleString();
const date = (value: string) =>
  new Date(
    value.length === 10 ? `${value}T00:00:00Z` : value,
  ).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
const pct = (part: number, total: number) =>
  total ? `${((100 * part) / total).toFixed(1)}%` : "—";
export function SessionChart({ days }: { days: Overview["days"] }) {
  const [active, setActive] = useState<number | null>(null);
  const point = active === null ? undefined : days[active];
  const max = Math.max(1, ...days.map((d) => d.sessions));
  const width = 960,
    height = 250,
    top = 15,
    bottom = 35,
    left = 45;
  const plot = height - top - bottom,
    step = (width - left - 15) / days.length;
  return (
    <section className="dh-panel dh-chart" aria-label="Daily session activity">
      <div className="dh-panel-heading">
        <div>
          <h2>Session activity</h2>
          <p>Last 30 days · UTC · By session first received</p>
        </div>
      </div>
      <div className="dh-legend">
        <span>
          <i className="dh-no-friction" />
          No friction
        </span>
        <span>
          <i className="dh-friction" />
          Friction
        </span>
      </div>
      <div className="dh-chart-plot" onMouseLeave={() => setActive(null)}>
        <div className="dh-chart-scroll" onScroll={() => setActive(null)}>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            role="group"
            aria-label="Daily stacked session counts by friction."
          >
            {[0, 1, 2, 3, 4].map((i) => (
              <g key={i}>
                <line
                  x1={left}
                  x2={width - 15}
                  y1={top + (i * plot) / 4}
                  y2={top + (i * plot) / 4}
                  className="dh-chart-grid"
                  strokeDasharray="3 3"
                />
                <text
                  x={left - 8}
                  y={top + (i * plot) / 4 + 4}
                  textAnchor="end"
                >
                  {Math.ceil((max * (4 - i)) / 4)}
                </text>
              </g>
            ))}
            {days.map((d, index) => {
              const parts = [
                d.sessions - d.serious_sessions,
                d.serious_sessions,
              ];
              const colors = ["#93c5fd", "#f59e0b"];
              let used = 0;
              const label = `${date(d.day)}: ${d.sessions} sessions, ${pct(d.sessions - d.serious_sessions, d.sessions)} no friction, ${pct(d.serious_sessions, d.sessions)} with friction, ${d.reviewed_sessions} reviewed.`;
              return (
                <g
                  key={d.day}
                  tabIndex={0}
                  role="img"
                  aria-label={label}
                  onMouseEnter={() => setActive(index)}
                  onFocus={() => setActive(index)}
                  onBlur={() => setActive(null)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setActive(null);
                  }}
                >
                  <rect
                    x={left + step * index}
                    y={top}
                    width={step}
                    height={plot}
                    className={active === index ? "dh-chart-hover" : ""}
                    fill={active === index ? undefined : "transparent"}
                  />
                  {parts.map((part, i) => {
                    used += part;
                    return (
                      <rect
                        key={i}
                        x={left + step * index + 4}
                        y={top + plot - (used / max) * plot}
                        width={step - 8}
                        height={(part / max) * plot}
                        fill={colors[i]}
                      />
                    );
                  })}
                  {(index % 5 === 0 || index === days.length - 1) && (
                    <text
                      x={left + step * (index + 0.5)}
                      y={height - 12}
                      textAnchor="middle"
                    >
                      {d.day.slice(5)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
        {point && (
          <div className="dh-chart-tooltip" aria-hidden="true">
            <strong>{date(point.day)}</strong>
            <div className="dh-chart-tooltip-total">
              {count(point.sessions)} sessions
            </div>
            <div className="dh-chart-tooltip-row">
              <span>
                <i className="dh-no-friction" />
                No friction
              </span>
              <b>{count(point.sessions - point.serious_sessions)}</b>
              <span>
                {pct(point.sessions - point.serious_sessions, point.sessions)}
              </span>
            </div>
            <div className="dh-chart-tooltip-row">
              <span>
                <i className="dh-friction" />
                Friction
              </span>
              <b>{count(point.serious_sessions)}</b>
              <span>{pct(point.serious_sessions, point.sessions)}</span>
            </div>
          </div>
        )}
      </div>
      {!days.some((d) => d.sessions) && (
        <p className="dh-state">No sessions received in the last 30 days.</p>
      )}
    </section>
  );
}
function OverviewTab() {
  const result = useData("overview", DashboardOverview);
  if (!result.data) return <LoadState {...result}>Loading overview…</LoadState>;
  const d = result.data;
  return (
    <>
      <div className="dh-title-row">
        <div>
          <h1>{d.name}</h1>
          <p>Overview of user sessions and detected problems</p>
        </div>
        <button
          className="dh-icon-button"
          onClick={result.retry}
          aria-label="Refresh overview"
        >
          <Icon name="refresh" />
        </button>
      </div>
      <div className="dh-summary-cards">
        <article className="dh-card" aria-label="Project bug counts">
          <div>
            <span>Open bugs</span>
            <Icon name="bugs" />
          </div>
          <strong>{count(d.open_bugs)}</strong>
          <dl className="dh-card-breakdown">
            <div>
              <dt>Fixed</dt>
              <dd>{count(d.fixed_bugs)}</dd>
            </div>
            <div>
              <dt>Wontfix</dt>
              <dd>{count(d.wontfix_bugs)}</dd>
            </div>
            <div>
              <dt>Invalid</dt>
              <dd>{count(d.invalid_bugs)}</dd>
            </div>
          </dl>
        </article>
        <article
          className="dh-card"
          aria-label="Session success over the last 24 hours"
        >
          <div>
            <span>Session success rate · 24h</span>
            <Icon name="sessions" />
          </div>
          <strong>
            {d.sessions_24h > 0
              ? `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format((100 * (d.sessions_24h - d.serious_sessions_24h)) / d.sessions_24h)}%`
              : "—"}
          </strong>
          <dl className="dh-card-breakdown">
            <div>
              <dt>Sessions</dt>
              <dd>{count(d.sessions_24h)}</dd>
            </div>
            <div>
              <dt>Friction</dt>
              <dd>{count(d.serious_sessions_24h)}</dd>
            </div>
          </dl>
          {d.sessions_24h === 0 && (
            <p className="dh-card-note">No sessions in the last 24 hours.</p>
          )}
        </article>
      </div>
      <SessionChart days={d.days} />
    </>
  );
}
const kindLabels: Record<string, string> = {
  testing: "Testing",
  "network-performance": "Network Performance",
  "react-rendering": "React Rendering",
  "layout-shift": "Layout Shift",
  glitches: "Glitches",
  "user-experience": "User Experience",
  accessibility: "Accessibility",
  "ui-details": "UI Details",
  "detail-journeys": "UI Details",
  seo: "SEO",
  security: "Security",
};
function bugKind(kind: string | null) {
  return kind ? (kindLabels[kind] ?? kind.replaceAll("-", " ")) : "—";
}
function FixPRs({ bug }: { bug: Bug }) {
  return bug.fix_prs.length ? (
    <div className="dh-fix-prs">
      {bug.fix_prs.map((pr) => (
        <a key={pr.url} href={pr.url} target="_blank" rel="noopener noreferrer">
          {pr.repo_full_name}#{pr.pr_number}
          {pr.state ? ` · ${pr.state}` : ""} ↗
        </a>
      ))}
    </div>
  ) : (
    <>—</>
  );
}
const evidenceLabels: Record<string, string> = {
  readsource: "Source",
  code_search: "Code search",
  logpoint: "Logpoint",
  evaluate: "Evaluate",
  screenshot: "Screenshot",
  describescreenshot: "Screenshot",
  consolemessages: "Console",
  networkrequest: "Network",
  network_replay: "Network",
  userinteractions: "User interactions",
  inspectelement: "Inspect element",
  git_blame: "Git blame",
  feature_flag_audit: "Feature flags",
  schema_diff: "Schema diff",
  provideddata: "Provided data",
};
export function EvidenceCards({
  items,
}: {
  items?: z.infer<typeof DashboardEvidence>[];
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  if (!items?.length) return null;
  return (
    <div className="dh-evidence">
      <div className="dh-evidence-label">
        Evidence <span>{items.length}</span>
      </div>
      {items.map((item, index) => {
        const words = item.tool
          .replace(/[_-]+/g, " ")
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .toLowerCase();
        const label =
          evidenceLabels[item.tool.trim().toLowerCase()] ??
          (words.charAt(0).toUpperCase() + words.slice(1) || "Evidence");
        const scalars = Object.entries(item.params ?? {}).filter(
          ([key, value]) =>
            !["recordingId", "recording_id"].includes(key) &&
            ["string", "number"].includes(typeof value),
        );
        const preferred =
          [
            "url",
            "path",
            "file",
            "filename",
            "source",
            "query",
            "pattern",
            "expression",
            "selector",
            "text",
            "message",
            "name",
          ]
            .map((key) => scalars.find(([name]) => name.toLowerCase() === key))
            .find(Boolean) ?? scalars[0];
        const preview = preferred
          ? String(preferred[1]).replace(/\s+/g, " ").trim()
          : "";
        const open = expanded === index;
        return (
          <div className="dh-evidence-card" key={index}>
            <button
              className="dh-evidence-toggle"
              aria-expanded={open}
              onClick={() => setExpanded(open ? null : index)}
            >
              <span className="dh-evidence-tool" title={item.tool}>
                {label}
              </span>
              <span className="dh-evidence-preview">
                {preview.length > 90 ? preview.slice(0, 89) + "…" : preview}
              </span>
              <span
                className={
                  open ? "dh-evidence-chevron open" : "dh-evidence-chevron"
                }
              >
                <Icon name="right" />
              </span>
            </button>
            {open && (
              <div className="dh-evidence-body">
                <div className="dh-evidence-label">{item.tool} · params</div>
                <pre>{JSON.stringify(item.params ?? {}, null, 2)}</pre>
                {item.result != null && (
                  <>
                    <div className="dh-evidence-label">Result</div>
                    <pre>{item.result}</pre>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
export function BugReport({
  bug,
}: {
  bug: z.infer<typeof DashboardBugDetail>;
}) {
  const sections = [
    ["Description", bug.description],
    ["Actual behavior", bug.actual_behavior],
    ["Expected behavior", bug.expected_behavior],
    ["Reproduction steps", bug.reproduction_steps],
    ["Impact", bug.analysis?.impact],
    ["Root cause", bug.analysis?.root_cause?.text],
    ["Notes", bug.notes],
    ["Resolution", bug.resolution],
  ];
  return (
    <>
      <div className="dh-title-row">
        <div>
          <a className="dh-back" href="/dashboard?tab=bugs">← Bugs</a>
          <h1>{bug.title}</h1>
          <p>
            {bugKind(bug.kind)} · {bug.severity} · {bug.status} · Detected{" "}
            {date(bug.discovered_at)}
          </p>
        </div>
      </div>
      <article className="dh-panel dh-report-body dh-bug-report">
        <section>
          <h2>Fix pull requests</h2>
          <FixPRs bug={bug} />
        </section>
        {sections.map(([label, value]) =>
          value ? (
            <section key={label}>
              <h2>{label}</h2>
              <p className="dh-prose">{value}</p>
              {label === "Root cause" && (
                <EvidenceCards items={bug.analysis?.root_cause?.evidence} />
              )}
            </section>
          ) : null,
        )}
        {!!bug.analysis?.chronology?.length && (
          <section>
            <h2>Walkthrough</h2>
            <ol>
              {bug.analysis.chronology.map((step, i) => (
                <li className="dh-prose" key={i}>
                  {step.text}
                  <EvidenceCards items={step.evidence} />
                  {step.screenshot_url && (
                    <a
                      href={step.screenshot_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <img
                        className="dh-bug-screenshot"
                        src={step.screenshot_url}
                        alt={`Walkthrough step ${i + 1}`}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                      />
                    </a>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}
        {!!bug.analysis?.chain?.length && (
          <section>
            <h2>Causal chain</h2>
            <ol>
              {bug.analysis.chain.map((step, i) => (
                <li className="dh-prose" key={i}>
                  {step.text}
                  <EvidenceCards items={step.evidence} />
                </li>
              ))}
            </ol>
          </section>
        )}
      </article>
    </>
  );
}
function BugDetailPage({ id }: { id: string }) {
  const result = useData(
    `bug?bug_id=${encodeURIComponent(id)}`,
    DashboardBugDetail,
  );
  return result.data ? (
    <BugReport bug={result.data} />
  ) : (
    <>
      <a className="dh-back" href="/dashboard?tab=bugs">← Bugs</a>
      <LoadState {...result}>Loading bug report…</LoadState>
    </>
  );
}
export function BugTable({ bugs }: { bugs: Bug[] }) {
  return (
    <div className="dh-table-scroll">
      <table className="dh-table">
        <thead>
          <tr>
            <th>Bug</th>
            <th>Kind</th>
            <th>Severity</th>
            <th>Pull requests</th>
            <th>Detected</th>
          </tr>
        </thead>
        <tbody>
          {[...bugs]
            .sort((a, b) => {
              const ranks: Record<string, number> = {
                critical: 0,
                high: 1,
                medium: 2,
                low: 3,
              };
              return (
                (ranks[a.severity] ?? 4) - (ranks[b.severity] ?? 4) ||
                Date.parse(b.discovered_at) - Date.parse(a.discovered_at)
              );
            })
            .map((b) => (
              <tr key={b.id}>
                <td>
                  <a href={b.url}>{b.title}</a>
                </td>
                <td>{bugKind(b.kind)}</td>
                <td>
                  <span
                    className={`dh-severity dh-severity-${["critical", "high", "medium", "low"].includes(b.severity) ? b.severity : "low"}`}
                  >
                    {b.severity}
                  </span>
                </td>
                <td>
                  <FixPRs bug={b} />
                </td>
                <td>
                  <time dateTime={b.discovered_at}>
                    {date(b.discovered_at)}
                  </time>
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
function BugsTab() {
  const [status, setStatus] = useState<"open" | "closed">("open");
  return (
    <>
      <div className="dh-tabs" aria-label="Bug status">
        {(["open", "closed"] as const).map((value) => (
          <button
            key={value}
            aria-pressed={status === value}
            onClick={() => setStatus(value)}
          >
            {value === "open" ? "Open bugs" : "Closed bugs"}
          </button>
        ))}
      </div>
      <BugList key={status} status={status} />
    </>
  );
}
function BugList({ status }: { status: "open" | "closed" }) {
  const [page, setPage] = useState(1);
  const result = useData(`bugs?status=${status}&page=${page}`, DashboardBugs);
  return (
    <>
      <div className="dh-title-row">
        <div>
          <h1>{status === "open" ? "Open bugs" : "Closed bugs"}</h1>
          <p>Read bug reports and follow linked fix pull requests.</p>
        </div>
        <button
          className="dh-icon-button"
          onClick={result.retry}
          aria-label="Refresh bugs"
        >
          <Icon name="refresh" />
        </button>
      </div>
      {result.data ? (
        <section className="dh-panel">
          <div className="dh-panel-heading">
            <h2>
              {count(result.data.total)} {status} bugs
            </h2>
          </div>
          {result.data.items.length ? (
            <BugTable bugs={result.data.items} />
          ) : (
            <p className="dh-state">No {status} bugs.</p>
          )}
          <div className="dh-pagination">
            <button
              className="dh-icon-button"
              disabled={page === 1}
              onClick={() => setPage((n) => n - 1)}
              aria-label="Previous bug page"
            >
              <Icon name="left" />
            </button>
            <span>Page {page}</span>
            <button
              className="dh-icon-button"
              disabled={!result.data.has_more}
              onClick={() => setPage((n) => n + 1)}
              aria-label="Next bug page"
            >
              <Icon name="right" />
            </button>
          </div>
        </section>
      ) : (
        <LoadState {...result}>Loading bugs…</LoadState>
      )}
    </>
  );
}
export function ReportBody({ run }: { run: NonNullable<Reports["run"]> }) {
  if (!run.output)
    return (
      <p className="dh-state" role="status">
        Report{" "}
        {run.status === "failed"
          ? "failed to generate."
          : `status: ${run.status}.`}
      </p>
    );
  const openBugs = run.bugs.filter(
    (b) => b.status === "open" || b.status === "reopened",
  );
  return (
    <div className="dh-report-body">
      <p className="dh-note">
        {run.reviewed_sessions ?? "—"} of {run.sessions ?? "—"} sessions
        reviewed · {run.timezone}
      </p>
      <section>
        <h3>Overview</h3>
        <p className="dh-prose">{run.output.overview}</p>
      </section>
      {[false, true].map((duplicate) => {
        const bugs = openBugs.filter((b) => b.is_duplicate === duplicate);
        return (
          <section key={String(duplicate)}>
            <h3>
              {duplicate ? "Duplicate bugs" : "New bugs"} ({bugs.length})
            </h3>
            {bugs.length ? (
              <BugTable bugs={bugs} />
            ) : (
              <p className="dh-note">
                No {duplicate ? "duplicate" : "new"} bugs.
              </p>
            )}
          </section>
        );
      })}
      {(["User trends", "Friction"] as const).map((category) => {
        const findings = run.output!.findings.filter(
          (f) => f.category === category,
        );
        return (
          findings.length > 0 && (
            <section key={category}>
              <h3>{category}</h3>
              {findings.map((f, i) => (
                <details className="dh-finding" key={i}>
                  <summary>
                    {f.title ?? f.text.split(/[.!?](?:\s|$)/)[0]}
                  </summary>
                  <p className="dh-prose">{f.text}</p>
                  {f.bugs.length > 0 && <BugTable bugs={f.bugs} />}
                </details>
              ))}
            </section>
          )
        );
      })}
    </div>
  );
}
function ReportsTab() {
  const [day, setDay] = useState<string>();
  const result = useData(
    `reports${day ? `?day=${day}` : ""}`,
    DashboardReports,
  );
  const history = result.data,
    run = history?.run;
  const shown = day ?? run?.day ?? "";
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  return (
    <>
      <div className="dh-title-row">
        <div>
          <h1>Daily reports</h1>
          <p>
            User behavior, recurring friction, and bugs from each day’s
            sessions.
          </p>
        </div>
        <button
          className="dh-icon-button"
          onClick={result.retry}
          aria-label="Refresh reports"
        >
          <Icon name="refresh" />
        </button>
      </div>
      <section className="dh-panel">
        <div className="dh-panel-heading">
          <h2>Daily user behavior</h2>
          <div className="dh-report-navigation">
            <button
              className="dh-icon-button"
              disabled={!history?.older}
              onClick={() => setDay(history?.older ?? undefined)}
              aria-label="Previous report"
            >
              <Icon name="left" />
            </button>
            <label className="dh-date-label">
              <span className="dh-sr-only">Report date</span>
              <input
                type="date"
                max={yesterday}
                value={shown}
                onChange={(event) => {
                  if (event.target.value && event.target.value <= yesterday)
                    setDay(event.target.value);
                }}
              />
            </label>
            <button
              className="dh-icon-button"
              disabled={!history?.newer}
              onClick={() => setDay(history?.newer ?? undefined)}
              aria-label="Next report"
            >
              <Icon name="right" />
            </button>
            <button onClick={() => setDay(undefined)} disabled={!day}>
              Latest
            </button>
          </div>
        </div>
        {!history ? (
          <LoadState {...result}>Loading daily report…</LoadState>
        ) : (
          <>
            {history.latest_attempt &&
              history.latest_attempt.day !== run?.day && (
                <p className="dh-note dh-report-status">
                  <button onClick={() => setDay(history.latest_attempt!.day)}>
                    {date(history.latest_attempt.day)}
                  </button>{" "}
                  · {history.latest_attempt.status}
                </p>
              )}
            {run ? (
              <ReportBody run={run} />
            ) : (
              <p className="dh-state">
                {day
                  ? `No report for ${date(day)}.`
                  : "No daily reports yet. Reports appear after the daily run."}
              </p>
            )}
          </>
        )}
      </section>
    </>
  );
}
function Snapshot({ id, timestamp }: { id: string; timestamp: number }) {
  const result = useData(
    `session-snapshot?${new URLSearchParams({ session_id: id, timestamp: String(timestamp) })}`,
    DashboardSessionSnapshot,
  );
  if (!result.data)
    return <LoadState {...result}>Loading screenshot…</LoadState>;
  return (
    <>
      {result.data.images.length ? (
        result.data.images.map((image, i) => (
          <img
            key={i}
            className="dh-session-screenshot"
            src={`data:${image.mime_type};base64,${image.data}`}
            alt={`Session at ${(timestamp / 1000).toFixed(1)} seconds`}
          />
        ))
      ) : (
        <p className="dh-note">No screenshot available at this point.</p>
      )}
    </>
  );
}
function SessionInteraction({
  id,
  event,
}: {
  id: string;
  event: { timestamp: number; text: string };
}) {
  const ref = useRef<HTMLLIElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return (
    <li ref={ref} className="dh-session-interaction">
      <h3>
        {(event.timestamp / 1000).toFixed(1)}s · {event.text}
      </h3>
      {visible ? (
        <Snapshot id={id} timestamp={event.timestamp} />
      ) : (
        <p className="dh-note">Screenshot loads when visible.</p>
      )}
    </li>
  );
}
function SessionDetail({ id, back }: { id: string; back: () => void }) {
  const result = useData(
    `session?session_id=${encodeURIComponent(id)}`,
    DashboardSessionDetail,
  );
  return (
    <>
      <button className="dh-back" onClick={back}>← Sessions</button>
      <div className="dh-title-row">
        <div>
          <h1>User session</h1>
          <p>{result.data?.session.user_email ?? id}</p>
        </div>
        <button
          className="dh-icon-button"
          aria-label="Refresh session"
          onClick={result.retry}
        >
          <Icon name="refresh" />
        </button>
      </div>
      {!result.data ? (
        <LoadState {...result}>Loading Subtext interactions…</LoadState>
      ) : (
        <section className="dh-panel dh-report-body">
          <p className="dh-note">
            Received {date(result.data.session.first_received_at)} ·{" "}
            {result.data.interactions.length} interactions
          </p>
          <ol className="dh-session-timeline">
            {result.data.interactions.map((event, index) => (
              <SessionInteraction
                key={`${id}-${index}-${event.timestamp}`}
                id={id}
                event={event}
              />
            ))}
          </ol>
          {!result.data.interactions.length && (
            <p className="dh-state">
              No interaction rows available yet. Refresh after processing.
            </p>
          )}
        </section>
      )}
    </>
  );
}
function SessionsTab() {
  const params = new URLSearchParams(window.location.search);
  const today = new Date().toISOString().slice(0, 10);
  const [day, setDay] = useState(
    DashboardDay.safeParse(params.get("day")).data || today,
  );
  const [page, setPage] = useState(0);
  const [id, setId] = useState(params.get("session"));
  const result = useData(`sessions?day=${day}&page=${page}`, DashboardSessions);
  useEffect(() => {
    const pop = () => {
      const p = new URLSearchParams(window.location.search);
      setId(p.get("session"));
      setDay(DashboardDay.safeParse(p.get("day")).data || today);
      setPage(0);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [today]);
  function navigate(nextDay: string, session: string | null = null) {
    setDay(nextDay);
    setPage(0);
    setId(session);
    window.history.pushState(
      null,
      "",
      `/dashboard?${new URLSearchParams({ tab: "sessions", day: nextDay, ...(session ? { session } : {}) })}`,
    );
  }
  const adjacent = (offset: number) =>
    new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86400000)
      .toISOString()
      .slice(0, 10);
  if (id) return <SessionDetail key={id} id={id} back={() => navigate(day)} />;
  return (
    <>
      <div className="dh-title-row">
        <div>
          <h1>User sessions</h1>
          <p>Captured sessions by first received date · UTC</p>
        </div>
        <button
          className="dh-icon-button"
          aria-label="Refresh sessions"
          onClick={result.retry}
        >
          <Icon name="refresh" />
        </button>
      </div>
      <section className="dh-panel">
        <div className="dh-panel-heading">
          <h2>Sessions</h2>
          <div className="dh-report-navigation">
            <button
              className="dh-icon-button"
              aria-label="Previous session day"
              onClick={() => navigate(adjacent(-1))}
            >
              <Icon name="left" />
            </button>
            <label className="dh-date-label">
              <span className="dh-sr-only">Session date</span>
              <input
                type="date"
                value={day}
                max={today}
                onChange={(e) => {
                  if (e.target.value && e.target.value <= today)
                    navigate(e.target.value);
                }}
              />
            </label>
            <button
              className="dh-icon-button"
              aria-label="Next session day"
              disabled={day >= today}
              onClick={() => navigate(adjacent(1))}
            >
              <Icon name="right" />
            </button>
          </div>
        </div>
        {!result.data ? (
          <LoadState {...result}>Loading sessions…</LoadState>
        ) : (
          <>
            {result.data.sessions.length ? (
              <div className="dh-table-scroll">
                <table className="dh-table">
                  <thead>
                    <tr>
                      <th>Session</th>
                      <th>User</th>
                      <th>First received (UTC)</th>
                      <th>Last received (UTC)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.data.sessions.map((session) => (
                      <tr key={session.session_id}>
                        <td>
                          <a
                            href={`/dashboard?${new URLSearchParams({ tab: "sessions", day, session: session.session_id })}`}
                            onClick={(e) => {
                              if (
                                !e.metaKey &&
                                !e.ctrlKey &&
                                !e.shiftKey &&
                                e.button === 0
                              ) {
                                e.preventDefault();
                                navigate(day, session.session_id);
                              }
                            }}
                          >
                            {session.session_id}
                          </a>
                        </td>
                        <td>{session.user_email ?? "Anonymous"}</td>
                        <td>
                          {new Date(session.first_received_at)
                            .toISOString()
                            .slice(11, 19)}
                        </td>
                        <td>
                          {new Date(session.last_received_at)
                            .toISOString()
                            .replace("T", " ")
                            .slice(0, 19)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="dh-state">No sessions captured on {date(day)}.</p>
            )}
            <div className="dh-pagination">
              <button
                className="dh-icon-button"
                aria-label="Previous session page"
                disabled={!page}
                onClick={() => setPage((p) => p - 1)}
              >
                <Icon name="left" />
              </button>
              <span>Page {page + 1}</span>
              <button
                className="dh-icon-button"
                aria-label="Next session page"
                disabled={!result.data.has_more}
                onClick={() => setPage((p) => p + 1)}
              >
                <Icon name="right" />
              </button>
            </div>
          </>
        )}
      </section>
    </>
  );
}
export default function Dashboard() {
  const initial = new URLSearchParams(window.location.search).get("tab");
  const [tab, setTab] = useState<Tab>(
    tabs.includes(initial as Tab) ? (initial as Tab) : "overview",
  );
  const [bugId, setBugId] = useState(
    new URLSearchParams(window.location.search).get("bug"),
  );
  const [ready, setReady] = useState(false),
    [error, setError] = useState("");
  const [openingError, setOpeningError] = useState<DashboardError>();
  useEffect(() => {
    // A factory may replace just the fragment in an already-open iframe.
    const newLink = () => {
      if (new URLSearchParams(window.location.hash.slice(1)).has("ticket"))
        window.location.reload();
    };
    window.addEventListener("hashchange", newLink);
    initialize()
      .then(() => setReady(true))
      .catch((e: unknown) => {
        const failure =
          e instanceof DashboardError
            ? e
            : new DashboardError(
                "Could not connect to Self Healing. Check your connection and try again.",
              );
        setOpeningError(failure);
        setError(failure.message);
      });
    return () => window.removeEventListener("hashchange", newLink);
  }, []);
  useEffect(() => {
    const pop = () => {
      const value = new URLSearchParams(window.location.search).get("tab");
      setBugId(new URLSearchParams(window.location.search).get("bug"));
      setTab(tabs.includes(value as Tab) ? (value as Tab) : "overview");
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  function navigate(value: Tab) {
    setTab(value);
    setBugId(null);
    window.history.pushState(null, "", `/dashboard?tab=${value}`);
  }
  async function logout() {
    try {
      await api("logout", undefined, {});
      // The cache outlives the component, so it has to go with the session it was filled from.
      clearDashboardCache();
      setReady(false);
      setError(
        "Dashboard session ended. Open a fresh link from your factory to return.",
      );
    } catch {
      setError("Could not end the session. Please try again.");
    }
  }
  return (
    <div className="dh-app">
      <div className="dh-chrome">
        <header className="dh-topbar">
          <a className="brand" href="/">
            <img className="brand-icon" src="/images/replay-logo.svg" alt="" />
            Self Healing
          </a>
          {ready && (
            <button className="dh-signout" onClick={logout}>
              End dashboard session
            </button>
          )}
        </header>
        <nav className="dh-tabnav" aria-label="Dashboard navigation">
          <div className="dh-tabnav-track">
            {tabs.map((t) => (
              <a
                href={`/dashboard?tab=${t}`}
                key={t}
                aria-current={t === tab ? "page" : undefined}
                onClick={(e) => {
                  if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
                    e.preventDefault();
                    navigate(t);
                  }
                }}
              >
                <Icon name={t} />
                {t[0]!.toUpperCase() + t.slice(1)}
              </a>
            ))}
          </div>
        </nav>
      </div>
      <main className="dh-main">
        {error ? (
          <div className="dh-state" role="alert">
            <h1>Couldn’t open the dashboard</h1>
            <p>{error}</p>
            {openingError?.requestId && (
              <details className="dh-error-details">
                <summary>Details for your factory</summary>
                <p>Error: {openingError.code ?? "unknown"}</p>
                <p>Request ID: {openingError.requestId}</p>
                <p>
                  Opened{" "}
                  {window.self === window.top
                    ? "directly in a browser"
                    : "inside an iframe"}
                  .
                </p>
              </details>
            )}
            {!ready && window.location.hash.includes("ticket=") && (
              <button onClick={() => window.location.reload()}>
                Retry opening dashboard
              </button>
            )}
          </div>
        ) : !ready ? (
          <p className="dh-state" role="status">
            Opening dashboard…
          </p>
        ) : tab === "overview" ? (
          <OverviewTab />
        ) : tab === "bugs" ? (
          bugId ? (
            <BugDetailPage id={bugId} />
          ) : (
            <BugsTab />
          )
        ) : tab === "sessions" ? (
          <SessionsTab />
        ) : (
          <ReportsTab />
        )}
      </main>
    </div>
  );
}
