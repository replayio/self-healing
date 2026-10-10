import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { upgradeSessionReviews } from "../scripts/lib/enable-session-reviews.ts";
import { enableSessionReviews } from "../src/api/review-settings.ts";

const settings = {
  enabled: false,
  create_journeys: true,
  sample_percent: 40,
  quiet_minutes: 20,
  max_reviews_per_day: 5,
  max_journeys_per_day: 2,
};
const reviewers = ["goals-and-outcomes", "friction-and-recovery"];

test("rollout enables disabled reviewers, preserving existing limits and already-enabled settings", async () => {
  const writes: unknown[] = [];
  await enableSessionReviews(
    async (_path, body) => {
      if (body) {
        writes.push(body);
        return { ok: true };
      }
      return {
        reviewers: reviewers.map((key, i) => ({
          key,
          settings: { ...settings, enabled: i === 0 },
        })),
      };
    },
    "project",
    true,
  );
  assert.deepEqual(writes, [
    {
      action: "settings",
      reviewer: "friction-and-recovery",
      settings: { ...settings, enabled: true },
    },
  ]);
  await assert.rejects(
    enableSessionReviews(async () => ({ ok: false }), "project"),
  );
});

test("deployment upgrades only ready account-owned connections with the corresponding QA identity", async () => {
  const db = new PGlite();
  try {
    for (const name of [
      "002_connections.sql",
      "003_session_coordination.sql",
      "004_accounts.sql",
      "006_connection_exploration.sql",
    ])
      await db.exec(
        await readFile(
          new URL(`../migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    const query = async (text: string, values: unknown[]) =>
      (await db.query<Record<string, unknown>>(text, values)).rows;
    const ids = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ];
    for (const [i, id] of ids.entries()) {
      await query(
        "INSERT INTO accounts(id,subtext_fingerprint,encrypted_subtext_key,api_key_hash,encrypted_api_key,encrypted_qa_token) VALUES ($1::uuid,$1::text,'encrypted',$1::text,'encrypted','encrypted')",
        [id],
      );
      await query(
        "INSERT INTO connections(id,account_id,encrypted_key,name,production_url,qa_project_id,ready) VALUES ($1::uuid,$1::text,'encrypted','app','https://example.com',$2,$3)",
        [id, `qa-${i}`, i < 2],
      );
    }
    const applied = new Map<string, Set<string>>();
    let fail = true;
    const client =
      async (account: string) => async (path: string, body?: unknown) => {
        assert.ok(
          ids.indexOf(account) < 2,
          "pending connections are not upgraded",
        );
        assert.ok(
          path.includes(`project_id=qa-${ids.indexOf(account)}`),
          "credentials stay scoped to the owning project",
        );
        const done = applied.get(account) ?? new Set<string>();
        applied.set(account, done);
        if (body) {
          if (account === ids[1] && fail) {
            fail = false;
            throw new Error("QA unavailable");
          }
          const input = body as { reviewer: string };
          assert.ok(
            !done.has(input.reviewer),
            "retries skip settings already enabled",
          );
          done.add(input.reviewer);
          return { ok: true };
        }
        return {
          reviewers: reviewers.map((key) => ({
            key,
            settings: { ...settings, enabled: done.has(key) },
          })),
        };
      };
    await assert.rejects(
      upgradeSessionReviews(query, client),
      /QA unavailable/,
    );
    assert.equal(await upgradeSessionReviews(query, client), 2);
    assert.deepEqual(
      [...applied.values()].map((set) => [...set]),
      [reviewers, reviewers],
    );
    assert.equal(await upgradeSessionReviews(query, client), 2);
    assert.equal(
      await upgradeSessionReviews(query, async (id) => {
        if (id === ids[1]) return null;
        return client(id);
      }),
      1,
    );
  } finally {
    await db.close();
  }
});
