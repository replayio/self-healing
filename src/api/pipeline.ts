import { z } from "zod";
import {
  BugVerification,
  BugVerifications,
  PipelineBug,
  QAId,
  VerificationInput,
} from "./contracts.ts";
import { dashboardData } from "./dashboard-data.ts";
import type { Connection } from "./connections.ts";
import { HttpError } from "./errors.ts";
import { qaClient, QARequestError } from "./qa.ts";

const Row = z.object({ id: QAId, project_id: QAId }).passthrough();
const SourceRun = Row.extend({
  journey_id: QAId.nullable(),
  journey_version_id: QAId.nullable(),
});
const Run = Row.extend({
  journey_id: QAId.nullable(),
  goal: z.string().nullable(),
  status: z.string(),
  outcome_status: z.string().nullish(),
  outcome_reason: z.string().nullish(),
  bugs_found_count: z.number().int().nonnegative(),
  replay_recording_id: z.string().nullish(),
  replay_recording_ids: z.record(z.string()).nullish(),
  created_at: z.string(),
  override_url: z.string().nullish(),
  environment_target_url: z.string().nullish(),
});
const marker = "Self Healing verification: ";
function recordings(row: {
  replay_recording_id?: string | null;
  replay_recording_ids?: Record<string, string> | null;
}) {
  return [
    ...new Set(
      [
        row.replay_recording_id,
        ...Object.values(row.replay_recording_ids ?? {}),
      ].filter((id): id is string => Boolean(id)),
    ),
  ].map((id) => `https://app.replay.io/recording/${encodeURIComponent(id)}`);
}
export function pipelineData(
  qa: ReturnType<typeof qaClient>,
  qaOrigin = process.env.REPLAY_QA_URL ?? "https://qa.replay.io",
) {
  async function read<T>(
    schema: z.ZodType<T>,
    path: string,
    body?: unknown,
    method?: "PATCH",
  ) {
    let raw: unknown;
    try {
      raw = await qa(path, body, undefined, method);
    } catch (e) {
      if (e instanceof QARequestError && [403, 404].includes(e.upstreamStatus))
        throw new HttpError(
          404,
          "not_found",
          "QA resource not found in this account.",
        );
      throw e;
    }
    const result = schema.safeParse(raw);
    if (!result.success)
      throw new HttpError(
        503,
        "qa_contract_changed",
        "QA returned unexpected pipeline data.",
      );
    return result.data;
  }
  function owned<T extends z.infer<typeof Row>>(row: T, c: Connection) {
    if (row.project_id !== c.qa_project_id)
      throw new HttpError(
        404,
        "not_found",
        "QA resource not found in this account.",
      );
    return row;
  }
  async function rawBug(c: Connection, id: string) {
    const b = owned(
      await read(
        Row.extend({
          test_run_id: QAId.nullish(),
          replay_recording_id: z.string().nullish(),
        }),
        `/api/v1/bugs/${encodeURIComponent(id)}`,
      ),
      c,
    );
    if (b.id !== id) throw new HttpError(404, "not_found", "Bug not found.");
    return b;
  }
  async function bug(c: Connection, id: string) {
    const raw = await rawBug(c, id);
    const detail = await dashboardData(async () => raw).bug(c, id);
    return PipelineBug.parse({
      ...detail,
      test_run_id: raw.test_run_id ?? null,
      recording_urls: recordings(raw),
      fix_reference: new URL(
        `/projects/${encodeURIComponent(c.qa_project_id!)}/bugs/${encodeURIComponent(id)}`,
        qaOrigin,
      ).href,
    });
  }
  async function source(c: Connection, id: string, replay = false) {
    const b = await rawBug(c, id);
    if (!b.test_run_id)
      throw new HttpError(
        409,
        "verification_unavailable",
        "This bug has no original QA journey to rerun.",
      );
    const run = owned(
      await read(
        SourceRun,
        `/api/test-runs/${encodeURIComponent(b.test_run_id)}`,
      ),
      c,
    );
    if (
      run.id !== b.test_run_id ||
      !run.journey_id ||
      (replay && (!run.journey_version_id || run.journey_steps == null))
    )
      throw new HttpError(
        409,
        "verification_unavailable",
        "The original QA journey is unavailable.",
      );
    if (replay) {
      const journey = owned(
        await read(Row, `/api/journeys/${encodeURIComponent(run.journey_id)}`),
        c,
      );
      if (journey.id !== run.journey_id)
        throw new HttpError(404, "not_found", "Journey not found.");
    }
    return run;
  }
  function verification(
    run: z.infer<typeof Run>,
    c: Connection,
    bugId: string,
  ) {
    owned(run, c);
    if (!run.goal?.startsWith(marker)) return null;
    let metadata: unknown;
    try {
      metadata = JSON.parse(run.goal.slice(marker.length).split("\n")[0]!);
    } catch {
      return null;
    }
    const input = VerificationInput.safeParse(metadata);
    if (!input.success || input.data.bug_id !== bugId) return null;
    // Do not describe a run on another environment as a verification of this preview.
    if (
      (run.override_url ?? run.environment_target_url) !==
      input.data.preview_url
    )
      throw new HttpError(
        503,
        "verification_target_mismatch",
        "QA did not report the requested preview target.",
      );
    return BugVerification.parse({
      ...input.data,
      run_id: run.id,
      status: run.status,
      outcome_status: run.outcome_status ?? null,
      outcome_reason: run.outcome_reason ?? null,
      bugs_found_count: run.bugs_found_count,
      recording_urls: recordings(run),
      created_at: run.created_at,
    });
  }
  return {
    bugs: (c: Connection, page: number) => dashboardData(qa).bugs(c, page),
    bug,
    async wontfix(c: Connection, id: string, reason: string) {
      await rawBug(c, id);
      await read(
        Row,
        `/api/v1/bugs/${encodeURIComponent(id)}`,
        { status: "wontfix", wontfix_reason: reason },
        "PATCH",
      ).then((row) => owned(row, c));
      const result = await bug(c, id);
      if (result.status !== "wontfix" || result.resolution !== reason)
        throw new HttpError(
          409,
          "disposition_changed",
          "Read the bug again: its disposition did not match the requested WONTFIX reason.",
        );
      return result;
    },
    async verify(c: Connection, input: z.infer<typeof VerificationInput>) {
      const original = await source(c, input.bug_id, true);
      const goal =
        marker +
        JSON.stringify(input) +
        "\nRerun the original reproduction against this preview and check that the reported defect no longer occurs.";
      const run = owned(
        await read(Run, "/api/test-runs", {
          project_id: c.qa_project_id,
          journey_id: original.journey_id,
          journey_version_id: original.journey_version_id,
          override_url: input.preview_url,
          goal,
        }),
        c,
      );
      if (run.journey_id !== original.journey_id)
        throw new HttpError(
          503,
          "qa_contract_changed",
          "QA returned a different verification journey.",
        );
      const result = verification(run, c, input.bug_id);
      if (!result)
        throw new HttpError(
          503,
          "qa_contract_changed",
          "QA did not retain the verification reference. Read verification runs before retrying.",
        );
      return result;
    },
    async verifications(c: Connection, bugId: string, page: number) {
      const original = await source(c, bugId);
      const result = await read(
        z.object({
          items: z.array(Run),
          total: z.number().int().nonnegative(),
        }),
        `/api/test-runs?${new URLSearchParams({ project_id: c.qa_project_id!, journey_id: original.journey_id!, page: String(page), pageSize: "100" })}`,
      );
      const items = result.items
        .map((run) => {
          if (run.journey_id !== original.journey_id)
            throw new HttpError(
              503,
              "qa_contract_changed",
              "QA returned a different journey's runs.",
            );
          return verification(run, c, bugId);
        })
        .filter((run): run is z.infer<typeof BugVerification> => run !== null);
      return BugVerifications.parse({
        items,
        page,
        has_more: page * 100 < result.total,
      });
    },
  };
}
