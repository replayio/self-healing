import { z } from "zod";
import {
  DashboardBug,
  DashboardBugDetail,
  DashboardBugs,
  DashboardOverview,
  DashboardReports,
} from "./contracts.ts";
import { HttpError } from "./errors.ts";
import { qaClient, QARequestError } from "./qa.ts";
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
          evidence: z
            .array(z.object({ tool: z.string(), result: z.string().nullish() }))
            .optional(),
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
const SessionPage = z.object({
  sessions: z.array(
    z.object({ session_id: z.string(), first_received_at: DateString }),
  ),
  has_more: z.boolean(),
});
const ReviewPage = z.object({
  totals: z.object({ total_sessions: Count }),
  deleted_codes: z.array(z.string()),
  runs: z.array(
    z.object({
      session_id: z.string(),
      output: z
        .object({
          observations: z.array(
            z.object({ code: z.string(), attributes: z.record(z.unknown()) }),
          ),
        })
        .nullable(),
      context: z.object({
        bugs: z.array(z.object({ id: z.string(), status: z.string() })),
      }),
    }),
  ),
  has_more: z.boolean(),
});
const ReviewerList = z.object({
  reviewers: z.array(z.object({ key: z.string() })),
});
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
  qa: ReturnType<typeof qaClient>,
  now = Date.now(),
) {
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
      );
    return parsed.data;
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
  const reviewerPath = (c: Connection) =>
    `/api/project-session-reviewers?project_id=${encodeURIComponent(c.qa_project_id!)}`;
  const bugsPath = (c: Connection) =>
    `/api/bugs?project_id=${encodeURIComponent(c.qa_project_id!)}&pageSize=100`;
  return {
    async overview(c: Connection) {
      const start = new Date(now);
      start.setUTCHours(0, 0, 0, 0);
      start.setUTCDate(start.getUTCDate() - 29);
      const from = start.toISOString();
      const days = Array.from({ length: 30 }, (_, i) => ({
        day: new Date(+start + i * DAY).toISOString().slice(0, 10),
        sessions: 0,
        reviewed_sessions: 0,
        bug_sessions: 0,
        serious_sessions: 0,
        both_sessions: 0,
      }));
      const byDay = new Map(days.map((day) => [day.day, day]));
      const sessionDays = new Map<string, string>();
      const reviewed = new Set<string>(),
        withBugs = new Set<string>(),
        serious = new Set<string>();
      const [bugCounts, , total] = await Promise.all([
        (async () => {
          const recent = new Set<string>();
          let open = 0,
            closed = 0;
          for (let page = 1; ; page++) {
            const result = await read(
              BugPage.extend({ resolvedCount: Count }),
              `${bugsPath(c)}&status=open&page=${page}`,
            );
            open = result.total;
            closed = result.resolvedCount;
            for (const item of result.items) {
              if (
                isOpen(item.status) &&
                Date.parse(item.discovered_at) >= now - DAY &&
                Date.parse(item.discovered_at) <= now
              )
                recent.add(item.id);
            }
            // QA sorts by discovered_at descending. Older backlog needn't be downloaded
            // to compute the rolling-day card; QA supplies the all-time totals.
            if (
              page * 100 >= result.total ||
              result.items.some((b) => Date.parse(b.discovered_at) < now - DAY)
            )
              break;
          }
          return { open, closed, recent: recent.size };
        })(),
        (async () => {
          for (let page = 0; ; page++) {
            const query = encodeURIComponent(JSON.stringify({ from, page }));
            const result = await read(
              SessionPage,
              `${reviewerPath(c)}&sessions=1&query=${query}`,
            );
            for (const s of result.sessions)
              sessionDays.set(
                s.session_id,
                new Date(s.first_received_at).toISOString().slice(0, 10),
              );
            if (!result.has_more) break;
          }
        })(),
        read(
          z.object({ totals: z.object({ total_sessions: Count }) }),
          `${reviewerPath(c)}&reviewer=friction-and-recovery&page=0`,
        ),
        (async () => {
          const list = await read(ReviewerList, `${reviewerPath(c)}&summary=1`);
          // Bug associations may come from any reviewer; impact=blocked is specific to friction.
          for (const reviewer of list.reviewers) {
            for (let page = 0; ; page++) {
              const result = await read(
                ReviewPage,
                `${reviewerPath(c)}&reviewer=${encodeURIComponent(reviewer.key)}&page=${page}&filter=${encodeURIComponent(JSON.stringify({ from }))}`,
              );
              for (const run of result.runs) {
                if (run.output) reviewed.add(run.session_id);
                if (
                  run.context.bugs.some(
                    (b) => !["judge-rejected", "invalid"].includes(b.status),
                  )
                )
                  withBugs.add(run.session_id);
                if (
                  reviewer.key === "friction-and-recovery" &&
                  run.output?.observations.some(
                    (o) =>
                      !result.deleted_codes.includes(o.code) &&
                      o.attributes.impact === "blocked",
                  )
                )
                  serious.add(run.session_id);
              }
              if (!result.has_more) break;
            }
          }
        })(),
      ]);
      for (const [id, day] of sessionDays) {
        const point = byDay.get(day);
        if (!point) continue;
        point.sessions++;
        if (reviewed.has(id)) point.reviewed_sessions++;
        if (withBugs.has(id)) point.bug_sessions++;
        if (serious.has(id)) point.serious_sessions++;
        if (withBugs.has(id) && serious.has(id)) point.both_sessions++;
      }
      return DashboardOverview.parse({
        name: c.name,
        sessions: total.totals.total_sessions,
        open_bugs: bugCounts.open,
        closed_bugs: bugCounts.closed,
        new_open_bugs: bugCounts.recent,
        days,
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
        );
      const b = parsed.data;
      return DashboardBugDetail.parse({
        ...bug(b),
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
                screenshot_url: screenshot(step),
              })),
            }
          : null,
      });
    },
    async bugs(c: Connection, page: number) {
      const result = await read(
        BugPage,
        `${bugsPath(c)}&status=open&severitySort=desc&page=${page}`,
      );
      return DashboardBugs.parse({
        items: result.items.map((b) => bug(b)),
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
      const bugs = run.bugs.map((b) => ({
        ...bug({ ...b, discovered_at: b.opened_at }),
        is_duplicate: b.is_duplicate,
        impacted_sessions: b.impacted_sessions,
      }));
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
