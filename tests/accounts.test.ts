import { managedDataConfigs } from "./helpers/account-services.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { accountService } from "../src/api/accounts.ts";
import { credentialVault } from "../src/api/credentials.ts";
import { connectionService } from "../src/api/connections.ts";
import { qaClient } from "../src/api/qa.ts";
import { createHandler } from "../src/api/handler.ts";
import { createStore } from "../src/api/store.ts";
import { HttpError } from "../src/api/errors.ts";

async function fixture() {
  const db = new PGlite();
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(dir)).sort())
    await db.exec(await readFile(new URL(file, dir), "utf8"));
  await db.exec(await readFile(new URL("004_accounts.sql", dir), "utf8"));
  const query = async (text: string, values: unknown[]) =>
    (await db.query<Record<string, unknown>>(text, values)).rows;
  const vault = credentialVault(Buffer.alloc(32, 3).toString("base64"));
  const issued: { slug: string; value: string }[] = [];
  let loseResponse = false;
  let validations = 0;
  const service = accountService(
    query,
    vault,
    async (request) => {
      validations++;
      if (!request.headers.get("authorization")?.startsWith("Bearer subtext-"))
        throw new HttpError(401, "unauthorized", "Invalid provider key");
      return { accountId: "unused-provider-identity" };
    },
    async (path, body) => {
      assert.equal(path, "/api/admin-service-accounts");
      const input = body as { slug: string; action: string };
      assert.equal(input.action, "issue_token");
      assert.ok(!JSON.stringify(body).includes("subtext-"));
      const value = `lqa_${String(issued.length + 1).repeat(48)}`;
      issued.push({ slug: input.slug, value });
      if (loseResponse) throw new Error("lost response");
      return {
        account: { user_id: `service|${input.slug}` },
        token: { id: `tok-${issued.length}`, value },
      };
    },
  );
  const work: { token: string; path: string }[] = [];
  const handler = createHandler({
    dataConfigs: managedDataConfigs,
    accounts: () => service,
    store: () => createStore(query),
    connections: (token) =>
      connectionService(
        query,
        qaClient({ REPLAY_QA_API_TOKEN: token }, async (url, init) => {
          const bearer = new Headers(init?.headers).get("authorization")!;
          assert.ok(
            issued.some((t) => bearer === `Bearer ${t.value}`),
            "customer work must use its QA token",
          );
          work.push({ token: bearer, path: String(url) });
          const path = new URL(String(url)).pathname;
          const result =
            path === "/api/v1/projects"
              ? { id: `project-${bearer.slice(-1)}` }
              : path.endsWith("/integrations/fullstory")
                ? { registration_token: "lqs_ingestion" }
                : { ok: true };
          return Response.json(result);
        }),
        vault,
        "https://healing.example",
      ),
  });
  const call = (path: string, key?: string, body?: unknown) =>
    handler(
      new Request(`https://healing.example/api/v1/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return {
    db,
    query,
    vault,
    service,
    issued,
    call,
    work,
    validations: () => validations,
    lose: () => {
      loseResponse = true;
    },
  };
}

test("provisioning validates once per attempt, retains encrypted credentials, and recovers the same account/key", async () => {
  const f = await fixture();
  try {
    const response = await f.call("accounts", undefined, {
      subtext_api_key: "subtext-a",
    });
    assert.equal(response.status, 200);
    const a = await response.json();
    assert.match(a.api_key, /^sh_[a-f0-9]{64}$/);
    assert.deepEqual(await f.service.provisionAccount("subtext-a"), a);
    assert.equal(f.issued.length, 1);
    assert.equal(f.issued[0]!.slug, `self-healing-${a.account_id}`);
    const rows = await f.query("SELECT * FROM accounts", []);
    for (const secret of ["subtext-a", a.api_key, f.issued[0]!.value])
      assert.ok(!JSON.stringify(rows).includes(secret));
    const credentials = await f.service.credentials(a.account_id);
    assert.equal(credentials.subtextKey, "subtext-a");
    assert.equal(credentials.qaToken, f.issued[0]!.value);
    assert.throws(() =>
      f.vault.decrypt(
        String(rows[0]!.encrypted_subtext_key),
        "other-fingerprint",
      ),
    );
    assert.equal(
      (await f.call("accounts", undefined, { subtext_api_key: "bad" })).status,
      401,
    );
    assert.equal(f.issued.length, 1);
  } finally {
    await f.db.close();
  }
});

test("account keys isolate local resources and every QA request; Subtext keys cannot authenticate", async () => {
  const f = await fixture();
  try {
    const a = await f.service.provisionAccount("subtext-a");
    const b = await f.service.provisionAccount("subtext-b");
    assert.notEqual(a.account_id, b.account_id);
    assert.notEqual(a.api_key, b.api_key);
    const validations = f.validations();
    for (const account of [a, b]) {
      const response = await f.call("connection", account.api_key, {
        name: "Example",
        production_url: "https://example.com",
      });
      assert.equal(response.status, 200, await response.text());
      assert.equal(
        (await f.call("connection/reviews", account.api_key)).status,
        200,
      );
      assert.equal(
        (await f.call("connection/reports", account.api_key)).status,
        200,
      );
    }
    for (let i = 0; i < 2; i++) {
      const requests = f.work.filter(
        (call) => call.token === `Bearer ${f.issued[i]!.value}`,
      );
      assert.ok(requests.length >= 7);
      assert.ok(
        requests
          .filter((call) => call.path.includes("project_id="))
          .every((call) => call.path.includes(`project-${i + 1}`)),
      );
    }
    const created = await f.call("projects", a.api_key, {
      name: "App",
      repository_url: "https://github.com/example/app",
      production_url: "https://example.com",
    });
    assert.equal(created.status, 201);
    const project = await created.json();
    assert.equal(
      (await f.call(`projects/${project.id}`, b.api_key)).status,
      404,
    );
    for (const key of [undefined, "subtext-a", "sh_" + "0".repeat(64)])
      assert.equal((await f.call("connection", key)).status, 401);
    assert.equal(
      f.validations(),
      validations,
      "ordinary API calls must never validate Subtext credentials",
    );
  } finally {
    await f.db.close();
  }
});

test("concurrent provisioning never issues two QA credentials for one key", async () => {
  const f = await fixture();
  try {
    const results = await Promise.allSettled([
      f.service.provisionAccount("subtext-a"),
      f.service.provisionAccount("subtext-a"),
    ]);
    assert.ok(results.some((r) => r.status === "fulfilled"));
    const recovered = await f.service.provisionAccount("subtext-a");
    for (const result of results)
      if (result.status === "fulfilled")
        assert.deepEqual(result.value, recovered);
    assert.equal(f.issued.length, 1);
  } finally {
    await f.db.close();
  }
});

test("lost issuance response blocks retries rather than silently creating extra QA tokens", async () => {
  const f = await fixture();
  try {
    f.lose();
    assert.equal(
      (await f.call("accounts", undefined, { subtext_api_key: "subtext-a" }))
        .status,
      500,
    );
    const retry = await f.call("accounts", undefined, {
      subtext_api_key: "subtext-a",
    });
    assert.equal(retry.status, 503);
    assert.equal((await retry.json()).error.code, "provisioning_pending");
    assert.equal(f.issued.length, 1);
    const [row] = await f.query(
      "SELECT encrypted_api_key, subtext_fingerprint FROM accounts",
      [],
    );
    const key = f.vault.decrypt(
      String(row!.encrypted_api_key),
      String(row!.subtext_fingerprint),
    );
    assert.equal((await f.call("projects", key)).status, 401);
  } finally {
    await f.db.close();
  }
});

test("new account callbacks decrypt only the retained Subtext key using its fingerprint", async () => {
  const f = await fixture();
  try {
    const account = await f.service.provisionAccount("subtext-a");
    const connection = await (
      await f.call("connection", account.api_key, {
        name: "Example",
        production_url: "https://example.com",
      })
    ).json();
    const sessionId = "33333333-3333-4333-8333-333333333333";
    await f.query(
      "INSERT INTO sessions(id,connection_id,session_url,review_request_id) VALUES ($1,$2,$3,$1)",
      [sessionId, connection.id, "https://app.fullstory.com/ui/org/session/1"],
    );
    const service = connectionService(
      f.query,
      async () => {
        throw new Error("Callback must not call QA");
      },
      f.vault,
      "https://healing.example",
    );
    let called = false;
    const response = await service.callback(
      sessionId,
      f.vault.gateway(sessionId),
      new Request("https://healing.example/callback"),
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      async (_url, init) => {
        called = true;
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Bearer subtext-a",
        );
        return Response.json(
          { jsonrpc: "2.0", id: 1, result: {} },
          { headers: { "mcp-session-id": "provider-session" } },
        );
      },
    );
    assert.equal(response.status, 200);
    assert.ok(called);
    assert.ok(!(await response.text()).includes("provider-session"));
  } finally {
    await f.db.close();
  }
});

test("missing provisioning configuration does not make an account's first issuance uncertain", async () => {
  const f = await fixture();
  const previous = process.env.LOOPQA_ADMIN_TOKEN;
  delete process.env.LOOPQA_ADMIN_TOKEN;
  try {
    const service = accountService(f.query, f.vault, async () => ({
      accountId: "unused",
    }));
    await assert.rejects(
      service.provisionAccount("subtext-a"),
      /not configured/,
    );
    const [row] = await f.query("SELECT qa_issue_attempted FROM accounts", []);
    assert.equal(row!.qa_issue_attempted, false);
    assert.ok((await f.service.provisionAccount("subtext-a")).api_key);
  } finally {
    if (previous !== undefined)
      process.env.LOOPQA_ADMIN_TOKEN = previous;
    await f.db.close();
  }
});
