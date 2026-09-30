import { neon } from "@neondatabase/serverless";
import type { z } from "zod";
import { FixPrInput, DashboardBug } from "./contracts.ts";
import type { Connection } from "./connections.ts";
import type { Query } from "./store.ts";

export function fixPrStore(query: Query) {
  return {
    async associate(c: Connection, input: z.infer<typeof FixPrInput>) {
      await query(
        `INSERT INTO bug_fix_prs (account_id, qa_project_id, bug_id, pr_url)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [c.account_id, c.qa_project_id, input.bug_id, input.pr_url],
      );
    },
    async augment<T extends z.infer<typeof DashboardBug>>(
      c: Connection,
      bugs: T[],
    ): Promise<T[]> {
      if (!bugs.length) return bugs;
      const rows = await query(
        `SELECT bug_id, pr_url FROM bug_fix_prs
         WHERE account_id = $1 AND qa_project_id = $2 AND bug_id = ANY($3::text[])
         ORDER BY pr_url`,
        [c.account_id, c.qa_project_id, bugs.map((b) => b.id)],
      );
      return bugs.map((bug) => {
        const prs = new Map(
          bug.fix_prs.map((pr) => [pr.url.toLowerCase(), pr]),
        );
        for (const row of rows.filter((row) => row.bug_id === bug.id)) {
          const url = String(row.pr_url);
          if (prs.has(url.toLowerCase())) continue;
          const [, owner, repo, , number] = new URL(url).pathname.split("/");
          prs.set(url.toLowerCase(), {
            repo_full_name: `${owner}/${repo}`,
            pr_number: Number(number),
            url,
            state: null,
          });
        }
        return { ...bug, fix_prs: [...prs.values()] };
      });
    },
  };
}
export function getFixPrStore() {
  if (!process.env.DATABASE_URL) throw new Error("Database is not configured");
  const sql = neon(process.env.DATABASE_URL);
  return fixPrStore(
    async (text, values) =>
      (await sql(text, values)) as Record<string, unknown>[],
  );
}
