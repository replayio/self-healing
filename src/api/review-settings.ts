import { z } from "zod";
import type { QAClient } from "./qa.ts";

export const REVIEW_QUIET_MINUTES = 15;
const SavedSettings = z.object({ ok: z.literal(true) });

// QA's existing scheduler checks upload inactivity every 15 minutes. Reapplying enabled
// settings preserves its activation window; do not disable/re-enable to reconcile setup.
export async function enableSessionReviews(
  qa: QAClient,
  projectId: string,
  preserveExisting = false,
) {
  const existing = preserveExisting
    ? z
        .object({
          reviewers: z.array(
            z.object({
              key: z.string(),
              settings: z.object({
                enabled: z.boolean(),
                create_journeys: z.boolean(),
                sample_percent: z.number(),
                quiet_minutes: z.number(),
                max_reviews_per_day: z.number().nullable(),
                max_journeys_per_day: z.number().nullable(),
              }),
            }),
          ),
        })
        .parse(
          await qa(
            `/api/project-session-reviewers?project_id=${encodeURIComponent(projectId)}&summary=1`,
          ),
        ).reviewers
    : undefined;
  for (const reviewer of ["goals-and-outcomes", "friction-and-recovery"]) {
    const current = existing?.find((row) => row.key === reviewer);
    if (existing && !current)
      throw new Error("QA did not return the configured reviewer");
    if (current?.settings.enabled) continue;
    SavedSettings.parse(
      await qa(
        `/api/project-session-reviewers?project_id=${encodeURIComponent(projectId)}`,
        {
          action: "settings",
          reviewer,
          settings: current
            ? { ...current.settings, enabled: true }
            : {
                enabled: true,
                create_journeys: reviewer === "friction-and-recovery",
                sample_percent: 100,
                quiet_minutes: REVIEW_QUIET_MINUTES,
                max_reviews_per_day: null,
                max_journeys_per_day: null,
              },
        },
      ),
    );
  }
}
