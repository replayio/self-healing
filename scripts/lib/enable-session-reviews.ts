import { z } from "zod";
import { enableSessionReviews } from "../../src/api/review-settings.ts";
import type { Query } from "../../src/api/store.ts";
import type { qaClient } from "../../src/api/qa.ts";

const ConnectionRows = z.array(
  z.object({
    id: z.string(),
    account_id: z.string(),
    qa_project_id: z.string(),
  }),
);

export async function upgradeSessionReviews(
  query: Query,
  clientForAccount: (id: string) => Promise<ReturnType<typeof qaClient>>,
) {
  let cursor = "";
  let configured = 0;
  for (;;) {
    const rows = ConnectionRows.parse(
      await query(
        `SELECT c.id::text, c.account_id, c.qa_project_id FROM connections c
       JOIN accounts a ON a.id::text=c.account_id
       WHERE c.ready AND c.qa_project_id IS NOT NULL AND c.id::text > $1
       ORDER BY c.id::text LIMIT 100`,
        [cursor],
      ),
    );
    if (!rows.length) return configured;
    for (const row of rows) {
      await enableSessionReviews(
        await clientForAccount(row.account_id),
        row.qa_project_id,
        true,
      );
      configured++;
      cursor = row.id;
    }
  }
}
