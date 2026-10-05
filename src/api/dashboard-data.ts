import type { getFixPrStore } from "./fix-prs.ts";
import { z } from "zod";
import {
  DashboardBug,
  DashboardEvidence,
  DashboardBugDetail,
  DashboardBugs,
  DashboardOverview,
  DashboardReports,
  QABugAggregates,
  QASessionAggregates,
} from "./contracts.ts";
import { HttpError, validationDiagnostics } from "./errors.ts";
import { type QAClient, QARequestError } from "./qa.ts";
import type { Connection } from "./connections.ts";

const Count = z.number().int().nonnegative();
const DateString = z
  .string()
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    "Expected a timestamp",
  );
const Bug = z.object({
  id: z.string(),
  title: z.string(),
  severity: z.string(),
  status: z.string(),
  discovered_at: DateString,
  polish_category: z.string().nullish(),
  test_run_id: z.string().nullish(),
  fix_prs: z
    .array(
      z.object({
        repo_full_name: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
        pr_number: z.number().int().positive(),
        pr_state: z.string().nullish(),
        merged_at: z.string().nullish(),
      }),
    )
    .nullish(),
});
const Analysis = DashboardBugDetail.shape.analysis
  .unwrap()
  .extend({
    chronology: z
      .array(
        z.object({
          text: z.string().optional(),
          screenshot_url: z.string().nullish(),
          evidence: z.array(DashboardEvidence).optional(),
        }),
      )
      .optional(),
  })
  .nullable();
// Match QA's Screenshot evidence first, then its legacy screenshot_url fallback.
function screenshot(
  step: NonNullable<
    NonNullable<z.infer<typeof Analysis>>["chronology"]
  >[number],
) {
  for (const e of step.evidence ?? []) {
    if (e.tool === "Screenshot") {
      const match = e.result?.match(
        /https:\/\/static\.replay\.io\/recordings\/[^\s"']+\/analysis\/screenshot-[^\s"'/]+\.jpg/,
      );
      if (match) return match[0];
    }
  }
  const url = step.screenshot_url;
  return url && /^https:\/\/static\.replay\.io\/recordings\/[^\s]+$/.test(url)
    ? url
    : null;
}
const BugPage = z.object({ items: z.array(Bug), total: Count });
const History = z.object({
  older: z.string().nullable(),
  newer: z.string().nullable(),
  latest_attempt: z.object({ day: z.string(), status: z.string() }).nullable(),
  run: z
    .object({
      day: z.string(),
      status: z.string(),
      timezone: z.string(),
      sessions: Count.nullable(),
      reviewed_sessions: Count.nullable(),
      output: z
        .object({
          overview: z.string(),
          findings: z.array(
            z.object({
              category: z.enum(["User trends", "Friction", "New bugs"]),
              title: z.string().optional(),
              text: z.string(),
              source_ids: z.array(z.string()),
            }),
          ),
        })
        .nullable(),
      bugs: z.array(
        Bug.omit({ discovered_at: true }).extend({
          opened_at: DateString,
          is_duplicate: z.boolean(),
          impacted_sessions: Count.nullable(),
        }),
      ),
      review_evidence: z.array(
        z.object({
          id: z.string(),
          bugs: z.array(z.object({ id: z.string() })),
        }),
      ),
    })
    .nullable(),
});
const isOpen = (status: string) => status === "open" || status === "reopened";
const DAY = 86400000;

// Use existing QA APIs; neither recordings nor report bodies are persisted by Self Healing.
export function dashboardData(
  qa: QAClient,
  now = Date.now(),
  fixPrs?: typeof getFixPrStore,
) {
  async function augment<T extends z.infer<typeof DashboardBug>>(
    c: Connection,
    bugs: T[],
  ) {
    return fixPrs ? fixPrs().augment(c, bugs) : bugs;
  }
  const deadline = Date.now() + 22000;
  async function read<T>(schema: z.ZodType<T>, path: string): Promise<T> {
    if (Date.now() > deadline)
      throw new HttpError(
        503,
        "dashboard_busy",
        "QA data took too long to load. Retry the dashboard.",
      );
    const parsed = schema.safeParse(await qa(path));
    if (!parsed.success)
      throw new HttpError(
        503,
        "qa_contract_changed",
        "QA returned unexpected dashboard data.",
        validationDiagnostics("qa_dashboard", parsed.error),
      );
    return parsed.data;
  }
  // Fan-out stays bounded: going wider than this trades QA's rate limit for the latency it saves.
  async function mapLimit<I, O>(items: I[], fn: (item: I) => Promise<O>) {
    const results = new Array<O>(items.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(6, items.length) }, async () => {
        for (let i = next++; i < items.length; i = next++)
          results[i] = await fn(items[i]!);
      }),
    );
    return results;
  }
  // QA reports the row count on the first page, so the remaining pages are fetched together rather
  // than walked one request at a time. Order is preserved because callers slice by page.
  async function readBugPages(path: (page: number) => string) {
    const first = await read(BugPage, path(1));
    const rest = Math.ceil(first.total / 100) - 1;
    if (rest < 1) return [first];
    return [
      first,
      ...(await mapLimit(
        Array.from({ length: rest }, (_, i) => i + 2),
        (page) => read(BugPage, path(page)),
      )),
    ];
  }
  const bug = (b: z.infer<typeof Bug>) =>
    DashboardBug.parse({
      ...b,
      kind: b.polish_category ?? (b.test_run_id ? "testing" : null),
      url: `/dashboard?tab=bugs&bug=${encodeURIComponent(b.id)}`,
      fix_prs: (b.fix_prs ?? []).map((pr) => ({
        ...pr,
        url: `https://github.com/${pr.repo_full_name}/pull/${pr.pr_number}`,
        state: pr.merged_at ? "merged" : (pr.pr_state ?? null),
      })),
    });
  const bugsPath = (c: Connection) =>
    `/api/bugs?project_id=${encodeURIComponent(c.qa_project_id!)}&pageSize=100`;
  return {
    async overview(c: Connection) {
      const start = new Date(now);
      start.setUTCHours(0, 0, 0, 0);
      const today = +start;
      start.setUTCDate(start.getUTCDate() - 29);
      const recent = {
        from: new Date(now - DAY).toISOString(),
        to: new Date(now).toISOString(),
      };
      const sessionFilter = {
        observation: {
          reviewer: "friction-and-recovery",
          attributes: { impact: "blocked" },
        },
        exclude_bug_statuses: ["judge-rejected", "invalid"],
      };
      const aggregatePath = (kind: "bugs" | "sessions", query: unknown) =>
        `/api/project-aggregates/${kind}?project_id=${encodeURIComponent(c.qa_project_id!)}&query=${encodeURIComponent(JSON.stringify(query))}`;
      const sessionSchema = QASessionAggregates.extend({
        project_id: z.literal(c.qa_project_id!),
      });
      // QA zero-fills every intersecting UTC bucket. At exactly midnight its exclusive
      // upper bound omits today, which the dashboard still displays as an empty date.
      const chartDays = now === today ? 29 : 30;
      const chartSchema = sessionSchema.refine(
        (value) =>
          value.series.length === chartDays &&
          value.series.every(
            (point, index) => Date.parse(point.start) === +start + index * DAY,
          ),
        {
          path: ["series"],
          message: "Expected complete, ordered UTC daily buckets",
        },
      );
      const [bugs, chart, recentSessions] = await Promise.all([
        read(
          QABugAggregates.extend({ project_id: z.literal(c.qa_project_id!) }),
          aggregatePath("bugs", recent),
        ),
        read(
          chartSchema,
          aggregatePath("sessions", {
            ...sessionFilter,
            from: start.toISOString(),
            to: recent.to,
            bucket: "day",
          }),
        ),
        read(
          sessionSchema,
          aggregatePath("sessions", { ...sessionFilter, ...recent }),
        ),
      ]);
      const counts = {
        open: 0,
        fixed: 0,
        wontfix: 0,
        invalid: 0,
        closed: 0,
        recent: 0,
      };
      for (const item of bugs.statuses) {
        if (isOpen(item.status)) {
          counts.open += item.total;
          counts.recent += item.in_period;
        } else if (
          item.status === "fixed" ||
          item.status === "wontfix" ||
          item.status === "invalid"
        ) {
          counts[item.status] += item.total;
          counts.closed += item.total;
        } else if (item.status === "pr-closed") counts.closed += item.total;
      }
      return DashboardOverview.parse({
        name: c.name,
        sessions: chart.all_time_sessions,
        sessions_24h: recentSessions.totals.sessions,
        serious_sessions_24h: recentSessions.totals.sessions_with_observations,
        open_bugs: counts.open,
        fixed_bugs: counts.fixed,
        wontfix_bugs: counts.wontfix,
        invalid_bugs: counts.invalid,
        closed_bugs: counts.closed,
        new_open_bugs: counts.recent,
        days: Array.from({ length: 30 }, (_, index) => {
          const point = chart.series[index];
          return {
            day: new Date(+start + index * DAY).toISOString().slice(0, 10),
            sessions: point?.sessions ?? 0,
            reviewed_sessions: point?.reviewed_sessions ?? 0,
            bug_sessions: point?.sessions_with_bugs ?? 0,
            serious_sessions: point?.sessions_with_observations ?? 0,
            both_sessions: point?.sessions_with_both ?? 0,
          };
        }),
      });
    },
    async bug(c: Connection, id: string) {
      // Check ownership before parsing/returning report content. Never pass the raw QA row through.
      const raw = await read(
        z.object({ id: z.string(), project_id: z.string() }).passthrough(),
        `/api/bugs/${encodeURIComponent(id)}`,
      ).catch((error) => {
        if (
          error instanceof QARequestError &&
          [403, 404].includes(error.upstreamStatus)
        )
          throw new HttpError(404, "not_found", "Bug not found.");
        throw error;
      });
      if (raw.project_id !== c.qa_project_id || raw.id !== id)
        throw new HttpError(404, "not_found", "Bug not found.");
      const parsed = Bug.merge(
        DashboardBugDetail.pick({
          description: true,
          reproduction_steps: true,
          expected_behavior: true,
          actual_behavior: true,
          notes: true,
          analysis: true,
        }).partial(),
      )
        .extend({
          wontfix_reason: z.string().nullish(),
          analysis: Analysis.optional(),
        })
        .safeParse(raw);
      if (!parsed.success)
        throw new HttpError(
          503,
          "qa_contract_changed",
          "QA returned unexpected bug data.",
          validationDiagnostics("qa_bug", parsed.error),
        );
      const b = parsed.data;
      return DashboardBugDetail.parse({
        ...(await augment(c, [bug(b)]))[0],
        description: b.description ?? null,
        reproduction_steps: b.reproduction_steps ?? null,
        expected_behavior: b.expected_behavior ?? null,
        actual_behavior: b.actual_behavior ?? null,
        notes: b.notes ?? null,
        resolution: b.wontfix_reason ?? null,
        analysis: b.analysis
          ? {
              ...b.analysis,
              chronology: b.analysis.chronology?.map((step) => ({
                text: step.text,
                evidence: step.evidence,
                screenshot_url: screenshot(step),
              })),
            }
          : null,
      });
    },
    async bugs(
      c: Connection,
      page: number,
      status: "open" | "closed" = "open",
    ) {
      if (status === "closed") {
        // QA has individual status filters, but no combined resolved filter.
        // Scan its ordered list before slicing so filtering cannot lose rows or pages.
        const closed = [] as z.infer<typeof Bug>[];
        for (const result of await readBugPages(
          (page) => `${bugsPath(c)}&status=all&severitySort=desc&page=${page}`,
        ))
          closed.push(
            ...result.items.filter((b) =>
              ["fixed", "wontfix", "invalid", "pr-closed"].includes(b.status),
            ),
          );
        return DashboardBugs.parse({
          items: await augment(
            c,
            closed.slice((page - 1) * 100, page * 100).map(bug),
          ),
          total: closed.length,
          page,
          has_more: page * 100 < closed.length,
        });
      }
      const result = await read(
        BugPage,
        `${bugsPath(c)}&status=open&severitySort=desc&page=${page}`,
      );
      return DashboardBugs.parse({
        items: await augment(
          c,
          result.items.map((b) => bug(b)),
        ),
        total: result.total,
        page,
        has_more: page * 100 < result.total,
      });
    },
    async reports(c: Connection, day?: string) {
      const result = await read(
        History,
        `/api/project-session-summarizers?${new URLSearchParams({ project_id: c.qa_project_id!, id: c.id, ...(day ? { day } : {}) })}`,
      );
      const run = result.run;
      if (!run) return DashboardReports.parse({ ...result, run: null });
      const bugs = await augment(
        c,
        run.bugs.map((b) => ({
          ...bug({ ...b, discovered_at: b.opened_at }),
          is_duplicate: b.is_duplicate,
          impacted_sessions: b.impacted_sessions,
        })),
      );
      return DashboardReports.parse({
        ...result,
        run: {
          ...run,
          bugs,
          output: run.output && {
            overview: run.output.overview,
            findings: run.output.findings.map((f) => {
              const ids = new Set([
                ...f.source_ids,
                ...run.review_evidence
                  .filter((r) => f.source_ids.includes(r.id))
                  .flatMap((r) => r.bugs.map((b) => b.id)),
              ]);
              return { ...f, bugs: bugs.filter((b) => ids.has(b.id)) };
            }),
          },
        },
      });
    },
  };
}
