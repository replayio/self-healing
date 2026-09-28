import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { credentialVault } from "../src/api/credentials.ts";
import { connectionService } from "../src/api/connections.ts";
import { gatewayRequest } from "../src/api/gateway.ts";
import { createHandler } from "../src/api/handler.ts";
import { qaClient } from "../src/api/qa.ts";

const db = new PGlite();
await db.exec(
  await readFile(
    new URL("../migrations/002_connections.sql", import.meta.url),
    "utf8",
  ),
);
after(() => db.close());
const vault = credentialVault(Buffer.alloc(32, 7).toString("base64"));
const query = async (text: string, values: unknown[]) =>
  (await db.query<Record<string, unknown>>(text, values)).rows;
const settings = { name: "Example", production_url: "https://example.com" };

test("credentials are encrypted with tenant binding and gateway tokens cannot cross connections", () => {
  const encrypted = vault.encrypt("customer-key", "a");
  assert.ok(!encrypted.includes("customer-key"));
  assert.equal(vault.decrypt(encrypted, "a"), "customer-key");
  assert.throws(() => vault.decrypt(encrypted, "b"));
  assert.throws(() => vault.decrypt(encrypted.slice(0, -4), "a"));
  assert.equal(vault.verifyGateway("a", vault.gateway("a")), true);
  assert.equal(vault.verifyGateway("b", vault.gateway("a")), false);
  assert.notEqual(vault.identity("a"), vault.identity("b"));
});

test("concurrent connections and lost QA responses recover one stable project without exposing the key", async () => {
  const calls: Record<string, unknown>[] = [];
  let fail = true;
  const service = connectionService(
    query,
    async (body) => {
      const call = body as Record<string, unknown>;
      calls.push(call);
      if (fail) {
        fail = false;
        throw new Error("lost response");
      }
      return { project_id: `proj-sh-${call.connection_id}` };
    },
    vault,
  );
  const account = vault.identity("one-key");
  await assert.rejects(service.connect(account, "one-key", settings));
  const pending = await service.get(account);
  assert.equal(pending.qa_project_id, null);
  const connected = await Promise.all([
    service.connect(account, "one-key", settings),
    service.connect(account, "one-key", settings),
  ]);
  assert.equal(connected[0]!.id, pending.id);
  assert.deepEqual(connected[0], connected[1]);
  assert.equal(new Set(calls.map((call) => call.connection_id)).size, 1);
  assert.ok(!JSON.stringify(calls).includes("one-key"));
  assert.equal(
    await service.gateway(pending.id, vault.gateway(pending.id)),
    "one-key",
  );
  await assert.rejects(service.gateway(pending.id, vault.gateway("other")));
  await assert.rejects(service.get(vault.identity("another-key")));
  await assert.rejects(
    service.connect(account, "one-key", { ...settings, name: "Different" }),
  );
});

test("connection routes authenticate, scope actions, and never expose ciphertext or gateway credentials", async () => {
  const requests: unknown[] = [];
  const service = connectionService(
    query,
    async (body) => {
      requests.push(body);
      return { project_id: "qa-two", session_id: "session", status: "stored" };
    },
    vault,
  );
  const handle = createHandler({
    authenticate: async (req) => ({
      accountId: vault.identity(req.headers.get("authorization")!),
    }),
    connections: () => service,
  });
  const call = (
    path: string,
    method: string,
    body?: unknown,
    key = "two-key",
  ) =>
    handle(
      new Request(`https://self-healing.test/api/v1/connection${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  assert.equal((await call("", "POST", settings)).status, 200);
  const response = await (await call("", "GET")).text();
  assert.ok(!/encrypted|gateway|two-key/.test(response));
  assert.equal((await call("", "GET", undefined, "other-key")).status, 404);
  assert.equal(
    (
      await call("/sessions", "POST", {
        session_url: "https://app.fullstory.com/ui/org/session/1",
        complete: true,
      })
    ).status,
    200,
  );
  assert.equal((requests.at(-1) as { action: string }).action, "session");
  assert.equal(
    (await call("/sessions", "POST", { session_url: "invalid" })).status,
    400,
  );
});

test("gateway uses only the fixed Subtext host and translates the QA capability to the provider key", async () => {
  let calls = 0;
  const request = new Request("https://self-healing.test/api/internal/test", {
    headers: {
      Authorization: "Basic internal-capability",
      "Mcp-Session-Id": "mcp-1",
    },
  });
  const upstream: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), "https://api.fullstory.com/mcp/subtext");
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer provider-key",
    );
    assert.equal(new Headers(init?.headers).get("Mcp-Session-Id"), "mcp-1");
    assert.equal(init?.redirect, "error");
    return Response.json(
      { result: {} },
      { headers: { "Mcp-Session-Id": "mcp-2" } },
    );
  };
  const response = await gatewayRequest(
    request,
    "provider-key",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "review-open",
        arguments: { session_url: "https://app.fullstory.com/session/1" },
      },
    },
    upstream,
  );
  assert.equal(response.headers.get("mcp-session-id"), "mcp-2");
  await assert.rejects(
    gatewayRequest(
      request,
      "provider-key",
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "delete-account" },
      },
      upstream,
    ),
  );
  assert.equal(calls, 1);
  await assert.rejects(
    gatewayRequest(
      request,
      "provider-key",
      { jsonrpc: "2.0", method: "tools/list" },
      async () => new Response("secret provider body", { status: 500 }),
    ),
    (error) => !String(error).includes("secret provider body"),
  );
});

test("QA transport sends only infrastructure credentials and sanitizes provider failures", async () => {
  const qa = qaClient(
    { REPLAY_QA_API_TOKEN: "service-token" },
    async (url, init) => {
      assert.equal(
        String(url),
        "https://qa.replay.io/.netlify/functions/self-healing",
      );
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer service-token",
      );
      assert.equal(init?.redirect, "error");
      return new Response("sensitive failure", { status: 500 });
    },
  );
  await assert.rejects(
    qa({ action: "reports" }),
    (error) => !String(error).includes("sensitive failure"),
  );
});
