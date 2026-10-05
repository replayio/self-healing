import { managedDataConfigs } from "./helpers/account-services.ts";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { serviceErrorStore } from "../src/api/service-errors.ts";
import { createHandler } from "../src/api/handler.ts";
import { accountService } from "../src/api/accounts.ts";
import { connectionService, type Connection } from "../src/api/connections.ts";
import { credentialVault } from "../src/api/credentials.ts";
import { pipelineData } from "../src/api/pipeline.ts";
import { HttpError } from "../src/api/errors.ts";

const db = new PGlite();
const migration = await readFile(
  new URL("../migrations/008_service_errors.sql", import.meta.url),
  "utf8",
);
await db.exec(migration);
await db.exec(migration);
after(() => db.close());
const store = serviceErrorStore(
  async (text, values) =>
    (await db.query<Record<string, unknown>>(text, values)).rows,
);
const vault = credentialVault(Buffer.alloc(32, 1).toString("base64"));
const connection: Connection = {
  id: "11111111-1111-4111-8111-111111111111",
  account_id: "account-a",
  name: "Example",
  qa_project_id: "qa-one",
  ready: true,
  encrypted_key: "encrypted",
  encrypted_ingest_token: "encrypted",
  production_url: "https://example.com",
  create_attempted: true,
  created_at: new Date(),
  reporting_start_day: new Date(),
  start_exploration: false,
};
const dependencies = {
  dataConfigs: managedDataConfigs,
  authenticate: async () => ({ accountId: "account-a" }),
  accounts: () => ({
    ...accountService(async () => [], vault),
    credentials: async () => ({
      qaToken: "SECRET_QA",
      subtextKey: "SECRET_SUBTEXT",
    }),
  }),
  connections: () => ({
    ...connectionService(async () => [], undefined, vault),
    get: async () => connection,
  }),
  pipelineData: () =>
    pipelineData(async () => ({
      id: "bug-1",
      project_id: "qa-one",
      title: "PRIVATE REPORT",
      severity: "high",
      status: "open",
      discovered_at: "2026-10-01",
      analysis: { chronology: [{ text: null }] },
      notes: "PRIVATE NOTES",
      test_run_id: null,
    })),
  serviceErrors: () => store,
};
const request = () =>
  new Request("https://example.com/api/v1/connection/bug?bug_id=bug-1", {
    headers: { Authorization: "Bearer SECRET_KEY", Cookie: "SECRET_COOKIE" },
  });

test("bug contract failures persist request/account/bug context and safe validation details", async () => {
  const response = await createHandler(dependencies)(request());
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, "qa_contract_changed");
  const id = response.headers.get("X-Request-Id")!;
  assert.equal(id, body.error.request_id);
  const row = await store.find("account-a", id);
  assert.ok(row);
  assert.equal(row.operation, "pipelineBug");
  assert.equal(row.bug_id, "bug-1");
  assert.ok(row.occurred_at);
  assert.deepEqual(row.diagnostics, {
    source: "qa_bug",
    issues: [
      {
        path: ["analysis", "chronology", 0, "text"],
        code: "invalid_type",
        received: "null",
      },
    ],
  });
  assert.equal(await store.find("account-b", id), null);
  assert.doesNotMatch(JSON.stringify(row), /SECRET|PRIVATE/);
  assert.equal(body.error.diagnostics, undefined);
  // Every retry gets independent durable evidence, rather than replacing the first failure.
  const retry = await createHandler(dependencies)(request());
  assert.notEqual(retry.headers.get("X-Request-Id"), id);
  assert.ok(await store.find("account-a", retry.headers.get("X-Request-Id")!));
});

test("persistence failure preserves the original response and emits sanitized fallback", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const response = await createHandler({
    ...dependencies,
    serviceErrors: () => ({
      ...store,
      record: async () => {
        throw new Error("SECRET DATABASE URL");
      },
    }),
  })(request());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "qa_contract_changed");
  assert.equal(log.mock.calls.length, 1);
  assert.doesNotMatch(
    JSON.stringify(log.mock.calls[0]!.arguments),
    /SECRET|PRIVATE/,
  );
});

test("unexpected exceptions persist without exception secrets; expected client failures do not", async () => {
  for (const failure of [
    new Error("SECRET DRIVER ERROR"),
    new HttpError(401, "unauthorized", "Denied"),
  ]) {
    const response = await createHandler({
      ...dependencies,
      authenticate: async () => {
        throw failure;
      },
    })(request());
    const id = response.headers.get("X-Request-Id")!;
    const rows = (
      await db.query<Record<string, unknown>>(
        "SELECT * FROM service_errors WHERE request_id = $1",
        [id],
      )
    ).rows;
    assert.equal(rows.length, failure instanceof HttpError ? 0 : 1);
    if (rows.length) {
      assert.equal(rows[0]!.account_id, null);
      assert.equal(rows[0]!.code, "internal_error");
      assert.doesNotMatch(JSON.stringify(rows), /SECRET/);
    }
  }
});
