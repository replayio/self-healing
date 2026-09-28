import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { z } from "zod";
import { credentialVault } from "./credentials.ts";
import { HttpError } from "./errors.ts";
import { qaClient } from "./qa.ts";
import { sessionService } from "./sessions.ts";
import type { Query } from "./store.ts";

const Row = z.object({
  id: z.string().uuid(),
  account_id: z.string(),
  encrypted_key: z.string(),
  name: z.string(),
  production_url: z.string(),
  qa_project_id: z.string().nullable(),
  encrypted_ingest_token: z.string().nullable(),
  create_attempted: z.boolean(),
  ready: z.boolean(),
  created_at: z.coerce.date(),
  reporting_start_day: z.coerce.date().nullable(),
});
export type Connection = z.infer<typeof Row>;
const ObjectResponse = z.object({}).passthrough();
export function connectionService(
  query: Query,
  qa = qaClient(),
  vault = credentialVault(),
  origin = process.env.SELF_HEALING_URL ?? "https://self-healing.replay.io",
) {
  const get = async (account: string) => {
    const [row] = await query(
      "SELECT * FROM connections WHERE account_id = $1",
      [account],
    );
    if (!row)
      throw new HttpError(
        404,
        "not_connected",
        "Connect this Subtext key first.",
      );
    return Row.parse(row);
  };
  const result = (c: Connection) => ({
    id: c.id,
    qa_project_id: c.qa_project_id,
    status: c.ready ? ("connected" as const) : ("pending" as const),
  });
  const sessions = sessionService(query, qa, vault, origin);
  const summaryPath = (c: Connection) =>
    `/api/project-session-summarizers?project_id=${encodeURIComponent(c.qa_project_id!)}`;
  return {
    get,
    async connect(
      account: string,
      key: string,
      input: { name: string; production_url: string },
    ) {
      await query(
        `INSERT INTO connections(id, account_id, encrypted_key, name, production_url) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT(account_id) DO NOTHING`,
        [
          randomUUID(),
          account,
          vault.encrypt(key, account),
          input.name,
          input.production_url,
        ],
      );
      let c = await get(account);
      if (c.name !== input.name || c.production_url !== input.production_url)
        throw new HttpError(
          409,
          "already_connected",
          "This key has different project settings.",
        );
      if (c.ready) return result(c);
      const lease = randomUUID();
      const locks = await query(
        `UPDATE connections SET lease=$2, lease_until=now()+interval '5 minutes'
        WHERE id=$1 AND (lease_until IS NULL OR lease_until < now()) RETURNING id`,
        [c.id, lease],
      );
      if (!locks.length)
        throw new HttpError(
          409,
          "connection_busy",
          "Connection setup is in progress; retry.",
        );
      try {
        c = await get(account);
        if (c.ready) return result(c);
        if (!c.qa_project_id) {
          // A stable name marker lets a lost create response be reconciled through QA's existing list API.
          const name = `${c.name} [${c.id}]`;
          let projectId: string | undefined;
          if (c.create_attempted) {
            for (let page = 1; ; page++) {
              const list = z
                .object({
                  items: z.array(
                    z.object({ id: z.string(), name: z.string() }),
                  ),
                  total: z.number(),
                })
                .parse(await qa(`/api/v1/projects?page=${page}&page_size=100`));
              const matches = list.items.filter((p) => p.name === name);
              if (matches.length > 1 || (matches.length && projectId))
                throw new HttpError(
                  409,
                  "provisioning_ambiguous",
                  "Multiple matching QA projects need operator reconciliation.",
                );
              projectId = matches[0]?.id ?? projectId;
              if (page * 100 >= list.total) break;
            }
            if (!projectId)
              throw new HttpError(
                503,
                "provisioning_pending",
                "The prior project creation is unresolved. Retry to reconcile; an operator may need to inspect QA.",
              );
          } else {
            await query(
              "UPDATE connections SET create_attempted=true WHERE id=$1",
              [c.id],
            );
            projectId = z.object({ id: z.string().min(1) }).parse(
              await qa("/api/v1/projects", {
                name,
                target_url: c.production_url,
                budget: 20,
                instructions:
                  "Test this application and reproduce user problems from submitted sessions.",
              }),
            ).id;
          }
          await query("UPDATE connections SET qa_project_id=$2 WHERE id=$1", [
            c.id,
            projectId,
          ]);
          c = await get(account);
        }
        if (!c.encrypted_ingest_token) {
          const setup = z
            .object({ instructions: z.string() })
            .parse(
              await qa(
                `/api/v1/projects/${encodeURIComponent(c.qa_project_id!)}/integrations/fullstory`,
                {},
              ),
            );
          // QA currently returns the one-time token in its installation guide, not a structured field.
          const tokens = [
            ...new Set(
              setup.instructions.match(/\blqs_[A-Za-z0-9_-]+\b/g) ?? [],
            ),
          ];
          if (tokens.length !== 1)
            throw new HttpError(
              503,
              "qa_contract_changed",
              "QA setup did not return one registration token.",
            );
          await query(
            "UPDATE connections SET encrypted_ingest_token=$2 WHERE id=$1",
            [c.id, vault.encrypt(tokens[0]!, c.account_id)],
          );
        }
        for (const reviewer of [
          "goals-and-outcomes",
          "friction-and-recovery",
        ]) {
          await qa(
            `/api/project-session-reviewers?project_id=${encodeURIComponent(c.qa_project_id!)}`,
            {
              action: "settings",
              reviewer,
              settings: {
                enabled: false,
                create_journeys: reviewer === "friction-and-recovery",
              },
            },
          );
        }
        await qa(summaryPath(c), {
          action: "save",
          id: c.id,
          definition: {
            name: "Daily user behavior",
            enabled: true,
            timezone: "UTC",
            hour: 8,
            prompt:
              "Summarize user goals, behavior trends, recurring friction and newly reported bugs. Cite supporting reviews and bugs, distinguish observations from confirmed problems, and state coverage limits. Compare with earlier reports when evidence supports it.",
          },
        });
        await query(
          "UPDATE connections SET ready=true, reporting_start_day=COALESCE(reporting_start_day,(now() AT TIME ZONE 'UTC')::date) WHERE id=$1",
          [c.id],
        );
        return result(await get(account));
      } finally {
        await query(
          "UPDATE connections SET lease_until=NULL WHERE id=$1 AND lease=$2",
          [c.id, lease],
        );
      }
    },
    async action(
      account: string,
      action: string,
      input: Record<string, unknown> = {},
    ) {
      const c = await get(account);
      if (!c.ready)
        throw new HttpError(
          409,
          "connection_pending",
          "Retry connection setup first.",
        );
      if (action === "session") return sessions.ingest(c, input);
      if (action === "reviews")
        return ObjectResponse.parse(
          await qa(
            `/api/project-session-reviewers?${new URLSearchParams({ project_id: c.qa_project_id!, reviewer: String(input.reviewer ?? "friction-and-recovery"), page: String(input.page ?? 0) })}`,
          ),
        );
      const day = typeof input.day === "string" ? input.day : undefined;
      if (action === "report") {
        const yesterday = new Date(Date.now() - 86400000)
          .toISOString()
          .slice(0, 10);
        if (day !== yesterday || new Date().getUTCHours() < 8)
          throw new HttpError(
            400,
            "invalid_report_day",
            "Request yesterday after 08:00 UTC.",
          );
      }
      const report = ObjectResponse.parse(
        await qa(
          `${summaryPath(c)}&id=${c.id}${day ? `&day=${encodeURIComponent(day)}` : ""}`,
        ),
      );
      if (action === "reports") return report;
      // The daily QA scheduler owns generation. Its manual run API replaces existing reports,
      // so a retry here reads status instead of submitting a destructive rerun.
      return {
        status: report.run
          ? "existing"
          : day! <
              (c.reporting_start_day ?? c.created_at).toISOString().slice(0, 10)
            ? "not_eligible"
            : "scheduled",
        ...report,
      };
    },
    callback: sessions.callback,
  };
}
export function getConnectionService() {
  if (!process.env.DATABASE_URL)
    throw new HttpError(
      503,
      "storage_unavailable",
      "Database is not configured.",
    );
  const sql = neon(process.env.DATABASE_URL);
  return connectionService(async (text, values) => await sql(text, values));
}
