import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { fixPrStore } from "../src/api/fix-prs.ts";
import { dashboardData } from "../src/api/dashboard-data.ts";
import type { Connection } from "../src/api/connections.ts";

test("durable PR associations are idempotent, account/project scoped and visible in bug reads", async () => {
  const db = new PGlite();
  try {
    for (const name of [
      "002_connections.sql",
      "007_bug_fix_prs.sql",
      "007_bug_fix_prs.sql",
    ])
      await db.exec(
        await readFile(
          new URL(`../migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    await db.exec(`INSERT INTO connections (id, account_id, encrypted_key, name, production_url, qa_project_id)
      VALUES ('11111111-1111-4111-8111-111111111111', 'account-a', 'encrypted', 'A', 'https://app.example', 'qa-one'),
             ('22222222-2222-4222-8222-222222222222', 'account-b', 'encrypted', 'B', 'https://app.example', 'qa-one')`);
    const query = async (text: string, values: unknown[]) =>
      (await db.query<Record<string, unknown>>(text, values)).rows;
    const store = fixPrStore(query);
    const c = {
      account_id: "account-a",
      qa_project_id: "qa-one",
    } as Connection;
    const other = { ...c, account_id: "account-b" };
    const input = {
      bug_id: "bug-1",
      pr_url: "https://github.com/example/app/pull/42",
    };
    await Promise.all([store.associate(c, input), store.associate(c, input)]);
    await store.associate(c, { ...input, bug_id: "bug-2" });
    assert.equal((await query("SELECT * FROM bug_fix_prs", [])).length, 2);
    const raw = {
      id: "bug-1",
      project_id: "qa-one",
      title: "Checkout",
      status: "open",
      severity: "high",
      discovered_at: "2026-09-30T00:00:00Z",
      fix_prs: [],
    };
    const read = (value: unknown) =>
      dashboardData(
        async () => value,
        Date.now(),
        () => store,
      );
    const bug = await read(raw).bug(c, raw.id);
    assert.deepEqual(bug.fix_prs, [
      {
        repo_full_name: "example/app",
        pr_number: 42,
        url: input.pr_url,
        state: null,
      },
    ]);
    assert.deepEqual((await read(raw).bug(other, raw.id)).fix_prs, []);
    assert.deepEqual(
      await store.augment({ ...c, qa_project_id: "qa-other" }, [
        { ...bug, fix_prs: [] },
      ]),
      [{ ...bug, fix_prs: [] }],
    );
    assert.equal(
      (await read({ items: [raw], total: 1 }).bugs(c, 1)).items[0]?.fix_prs[0]
        ?.url,
      input.pr_url,
    );
    const reports = await read({
      older: null,
      newer: null,
      latest_attempt: null,
      run: {
        day: "2026-09-30",
        status: "completed",
        timezone: "UTC",
        sessions: 1,
        reviewed_sessions: 1,
        output: {
          overview: "Checkout fails",
          findings: [
            { category: "Friction", text: "Checkout", source_ids: [raw.id] },
          ],
        },
        bugs: [
          {
            ...raw,
            opened_at: raw.discovered_at,
            is_duplicate: false,
            impacted_sessions: 1,
          },
        ],
        review_evidence: [],
      },
    }).reports({ ...c, id: "11111111-1111-4111-8111-111111111111" });
    assert.equal(reports.run?.bugs[0]?.fix_prs[0]?.url, input.pr_url);
    assert.equal(
      reports.run?.output?.findings[0]?.bugs[0]?.fix_prs[0]?.url,
      input.pr_url,
    );
    // Provider state wins if the optional GitHub integration also knows this PR.
    const known = {
      ...bug,
      fix_prs: [{ ...bug.fix_prs[0]!, state: "merged" }],
    };
    assert.deepEqual(await store.augment(c, [known]), [known]);
    const fresh = fixPrStore(query);
    assert.deepEqual(await fresh.augment(c, [{ ...bug, fix_prs: [] }]), [bug]);
  } finally {
    await db.close();
  }
});
