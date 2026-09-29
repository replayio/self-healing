import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { credentialVault } from "../src/api/credentials.ts";
import { connectionService } from "../src/api/connections.ts";
import { createHandler } from "../src/api/handler.ts";
import { getOpenApiSpec } from "../src/api/openapi.ts";
import { splitBatches } from "../packages/capture/src/transport.ts";
import { qaClient } from "../src/api/qa.ts";

const vault = credentialVault(Buffer.alloc(32, 7).toString("base64"));
const settings = { name: "Example", production_url: "https://example.com" };
const sessionUrl = "https://app.fullstory.com/ui/org/session/1";
async function fixture() {
  const db = new PGlite();
  for (const name of [
    "002_connections.sql",
    "003_session_coordination.sql",
    "004_accounts.sql",
  ])
    await db.exec(
      await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"),
    );
  const query = async (text: string, values: unknown[]) =>
    (await db.query<Record<string, unknown>>(text, values)).rows;
  const calls: { path: string; body: unknown; token: string | undefined }[] =
    [];
  const projects: { id: string; name: string }[] = [];
  const reviews = new Map<string, string>();
  let loseCreate = false,
    loseReview = false,
    rejectReview = false;
  const qa = async (
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<unknown> => {
    calls.push({ path, body, token });
    const b = body as Record<string, unknown>;
    if (path === "/api/v1/projects") {
      projects.push({ id: `qa-${projects.length}`, name: String(b.name) });
      if (loseCreate) {
        loseCreate = false;
        throw new Error("lost response");
      }
      return projects.at(-1);
    }
    if (path.startsWith("/api/v1/projects?"))
      return { items: projects, total: projects.length };
    if (path.endsWith("/integrations/fullstory"))
      return {
        registration_token: "lqs_registration-token",
      };
    if (path === "/api/project-session/register") {
      assert.equal(token, "lqs_registration-token");
      assert.match(
        String(b.source_callback_url),
        /^https:\/\/healing.example\/api\/internal\/sessions\//,
      );
      return { session_id: `fs-${String(b.session_url).split("/").at(-1)}` };
    }
    if (path.startsWith("/api/project-session-reviewers")) {
      if (b?.action === "settings") return { ok: true };
      if (body !== undefined) {
        assert.equal(b.action, "review");
        const id = (b.session_ids as string[])[0]!;
        const key = `${b.reviewer}:${b.request_id}`;
        const status =
          reviews.has(key) || rejectReview ? "not_queued" : "queued";
        if (status === "queued") reviews.set(key, id);
        if (loseReview) {
          loseReview = false;
          throw new Error("lost review response");
        }
        return { results: [{ session_id: id, status }] };
      }
      const reviewer = new URL(path, "https://qa.example").searchParams.get(
        "reviewer",
      );
      return {
        runs: [...reviews]
          .filter(([k]) => k.startsWith(`${reviewer}:`))
          .map(([, session_id]) => ({ session_id })),
        has_more: false,
      };
    }
    if (path.startsWith("/api/project-session-summarizers"))
      return body ? { ok: true } : { run: null };
    throw new Error(`Unexpected QA API ${path}`);
  };
  const service = connectionService(
    query,
    qa,
    vault,
    "https://healing.example",
  );
  const account = vault.identity("customer-key");
  return {
    db,
    query,
    calls,
    projects,
    reviews,
    service,
    account,
    loseCreate: () => {
      loseCreate = true;
    },
    loseReview: () => {
      loseReview = true;
    },
    rejectReviews: (value: boolean) => {
      rejectReview = value;
    },
  };
}
test("credentials bind ciphertext and callback tokens to their owner", () => {
  const encrypted = vault.encrypt("customer-key", "a");
  assert.ok(!encrypted.includes("customer-key"));
  assert.equal(vault.decrypt(encrypted, "a"), "customer-key");
  assert.throws(() => vault.decrypt(encrypted, "b"));
  assert.throws(() => vault.decrypt(encrypted.slice(0, -4), "a"));
  assert.equal(
    vault.verifyGateway("session-b", vault.gateway("session-a")),
    false,
  );
});
test("lost creation response reconciles through existing QA APIs without duplicate projects", async () => {
  const f = await fixture();
  try {
    f.loseCreate();
    await assert.rejects(
      f.service.connect(f.account, "customer-key", settings),
    );
    const connected = await f.service.connect(
      f.account,
      "customer-key",
      settings,
    );
    assert.equal(connected.status, "connected");
    await f.service.connect(f.account, "customer-key", settings);
    assert.equal(f.projects.length, 1);
    assert.equal(
      f.calls.filter((c) => c.path.endsWith("/integrations/fullstory")).length,
      1,
    );
    assert.ok(!JSON.stringify(f.calls).includes("customer-key"));
    await assert.rejects(f.service.get(vault.identity("other-key")));
    await assert.rejects(
      f.service.connect(f.account, "customer-key", {
        ...settings,
        name: "other",
      }),
    );
    const row = await f.service.get(f.account);
    assert.ok(!row.encrypted_ingest_token?.includes("lqs_"));
  } finally {
    await f.db.close();
  }
});
test("concurrent setup is serialized and ambiguous creation never blindly retries POST", async () => {
  const f = await fixture();
  try {
    const results = await Promise.allSettled([
      f.service.connect(f.account, "customer-key", settings),
      f.service.connect(f.account, "customer-key", settings),
    ]);
    assert.ok(results.some((r) => r.status === "fulfilled"));
    assert.equal(f.projects.length, 1);
    await f.query(
      "UPDATE connections SET qa_project_id=NULL, ready=false, create_attempted=true WHERE account_id=$1",
      [f.account],
    );
    f.projects.length = 0;
    await assert.rejects(
      f.service.connect(f.account, "customer-key", settings),
      /unresolved/,
    );
    assert.equal(f.projects.length, 0);
  } finally {
    await f.db.close();
  }
});
test("uploads rely on automatic QA reviews, stay open, and deduplicate retries", async () => {
  const f = await fixture();
  try {
    await f.service.connect(f.account, "customer-key", settings);
    const configs = f.calls
      .filter((c) => c.path.startsWith("/api/project-session-reviewers"))
      .map((c) => c.body);
    assert.deepEqual(
      configs,
      ["goals-and-outcomes", "friction-and-recovery"].map((reviewer) => ({
        action: "settings",
        reviewer,
        settings: {
          enabled: true,
          create_journeys: reviewer === "friction-and-recovery",
          sample_percent: 100,
          quiet_minutes: 15,
          max_reviews_per_day: null,
          max_journeys_per_day: null,
        },
      })),
    );
    const input = { session_url: sessionUrl, auxiliary_data: [] };
    const first = await f.service.action(f.account, "session", input);
    assert.equal(first.status, "stored");
    assert.deepEqual(
      await f.service.action(f.account, "session", input),
      first,
    );
    assert.equal(
      f.calls.filter((c) => c.path === "/api/project-session/register").length,
      1,
    );
    assert.equal(
      (
        await f.service.action(f.account, "session", {
          ...input,
          complete: true,
        })
      ).status,
      "stored",
    );
    await f.service.action(f.account, "session", {
      ...input,
      auxiliary_data: [
        {
          namespace: "session",
          key: "identity",
          schema_version: 1,
          payload: { version: 1, email: "user@example.com" },
        },
      ],
    });
    assert.equal(
      f.reviews.size,
      0,
      "ingestion never queues manual reviews alongside the scheduler",
    );
    assert.equal(
      (await f.query("SELECT sealed FROM sessions", []))[0]?.sealed,
      false,
    );
    await assert.rejects(f.service.action("other", "session", input));
  } finally {
    await f.db.close();
  }
});

test("previously sealed sessions accept new captures without installer intervention", async () => {
  const f = await fixture();
  try {
    await f.service.connect(f.account, "customer-key", settings);
    await f.service.action(f.account, "session", { session_url: sessionUrl });
    await f.query("UPDATE sessions SET sealed=true", []);
    const result = await f.service.action(f.account, "session", {
      session_url: sessionUrl,
      auxiliary_data: [
        {
          namespace: "session",
          key: "identity",
          schema_version: 1,
          payload: { version: 1, email: "later@example.com" },
        },
      ],
    });
    assert.equal(result.status, "stored");
  } finally {
    await f.db.close();
  }
});
test("callback enforces session and MCP-client scope without exposing upstream credentials", async () => {
  const f = await fixture();
  try {
    await f.service.connect(f.account, "customer-key", settings);
    await f.service.action(f.account, "session", { session_url: sessionUrl });
    const upload = f.calls.find(
      (c) => c.path === "/api/project-session/register",
    )!.body as { source_callback_url: string };
    const url = upload.source_callback_url;
    const parts = new URL(url).pathname.split("/");
    const id = parts[4]!,
      token = parts[6]!;
    let upstreamCalls = 0;
    const upstream: typeof fetch = async (_url, init) => {
      upstreamCalls++;
      assert.equal(String(_url), "https://api.fullstory.com/mcp/subtext");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer customer-key",
      );
      const rpc = JSON.parse(String(init?.body)) as {
        method: string;
        params?: { name: string };
      };
      return Response.json(
        {
          jsonrpc: "2.0",
          id: 1,
          result:
            rpc.params?.name === "review-open"
              ? { content: [{ type: "text", text: "client_id: owned-client" }] }
              : {},
        },
        { headers: { "mcp-session-id": "upstream-secret" } },
      );
    };
    const invoke = (rpc: unknown, context?: string) =>
      f.service.callback(
        id,
        token,
        new Request(url, {
          headers: context ? { "mcp-session-id": context } : {},
        }),
        rpc,
        upstream,
      );
    const init = await invoke({ jsonrpc: "2.0", method: "initialize", id: 1 });
    const context = init.headers.get("mcp-session-id")!;
    assert.notEqual(context, "upstream-secret");
    const call = (name: string, args: unknown) => ({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args },
    });
    await assert.rejects(
      invoke(call("review-open", { url: sessionUrl + "other" }), context),
    );
    await invoke(call("review-open", { url: sessionUrl }), context);
    await assert.rejects(
      invoke(call("review-zoom", { client_id: "foreign" }), context),
    );
    await invoke(
      call("review-zoom", {
        client_id: "owned-client",
        resolution: { network: "detail" },
      }),
      context,
    );
    assert.equal(upstreamCalls, 3);
    // A fresh MCP context may reuse a client opened for this same session after a reconnect.
    const reinit = await invoke({
      jsonrpc: "2.0",
      method: "initialize",
      id: 3,
    });
    await invoke(
      call("review-zoom", { client_id: "owned-client" }),
      reinit.headers.get("mcp-session-id")!,
    );

    await assert.rejects(
      f.service.callback(
        id,
        vault.gateway("other"),
        new Request(url),
        {},
        upstream,
      ),
    );
    await f.service.action(f.account, "session", {
      session_url: sessionUrl + "two",
    });
    const other = f.calls
      .filter((c) => c.path === "/api/project-session/register")
      .at(-1)!.body as { source_callback_url: string };
    const otherParts = new URL(other.source_callback_url).pathname.split("/");
    await assert.rejects(
      f.service.callback(
        otherParts[4]!,
        otherParts[6]!,
        new Request(other.source_callback_url, {
          headers: { "mcp-session-id": context },
        }),
        { jsonrpc: "2.0", method: "tools/list" },
        upstream,
      ),
      /Initialize/,
    );
    const stored = JSON.stringify(
      await f.query("SELECT * FROM gateway_contexts", []),
    );
    assert.ok(!stored.includes("upstream-secret"));
  } finally {
    await f.db.close();
  }
});
test("connection responses hide internal credentials and QA transport uses existing API paths", async () => {
  const f = await fixture();
  try {
    const handle = createHandler({
      authenticate: async () => ({ accountId: f.account }),
      connections: () => f.service,
      accounts: () => ({
        credentials: async () => ({
          subtextKey: "customer-key",
          qaToken: "qa-token",
        }),
        authenticate: async () => ({ accountId: f.account }),
        provisionAccount: async () => {
          throw new Error("not used");
        },
      }),
    });
    const request = (method: string, body?: unknown) =>
      new Request("https://healing.example/api/v1/connection", {
        method,
        headers: {
          authorization: "Bearer customer-key",
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    assert.equal((await handle(request("POST", settings))).status, 200);
    const response = await (await handle(request("GET"))).text();
    assert.ok(!/encrypted|customer-key|lqs_|lease/.test(response));
    const qa = qaClient(
      { REPLAY_QA_API_TOKEN: "service" },
      async (url, init) => {
        assert.equal(
          String(url),
          "https://qa.replay.io/api/project-session/register",
        );
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Bearer lqs_ingest",
        );
        return new Response("secret upstream error", { status: 500 });
      },
    );
    await assert.rejects(
      qa("/api/project-session/register", {}, "lqs_ingest"),
      (e) => !String(e).includes("secret upstream"),
    );
  } finally {
    await f.db.close();
  }
});
test("report status reads never invoke QA's destructive manual rerun API", async () => {
  const f = await fixture();
  try {
    await f.service.connect(f.account, "customer-key", settings);
    await f.service.action(f.account, "reports", { day: "2026-01-01" });
    assert.equal(
      f.calls.filter(
        (c) => c.path.includes("summarizers") && c.body !== undefined,
      ).length,
      1,
    );
  } finally {
    await f.db.close();
  }
});

test("package producer metadata passes HTTP validation and is forwarded unchanged to QA", async () => {
  const f = await fixture();
  try {
    await f.service.connect(f.account, "customer-key", settings);
    const handle = createHandler({
      authenticate: async () => ({ accountId: f.account }),
      connections: () => f.service,
      accounts: () => ({
        credentials: async () => ({
          subtextKey: "customer-key",
          qaToken: "qa-token",
        }),
        authenticate: async () => ({ accountId: f.account }),
        provisionAccount: async () => {
          throw new Error("not used");
        },
      }),
    });
    const manifest = JSON.parse(
      await readFile(
        new URL("../packages/capture/package.json", import.meta.url),
        "utf8",
      ),
    );
    const producer = {
      namespace: "session",
      key: "capture-producer",
      schema_version: 1,
      payload: { name: manifest.name, version: manifest.version },
    };
    const artifacts = [
      producer,
      {
        namespace: "session",
        key: "metrics",
        schema_version: 1,
        payload: { version: 1, interaction_count: 1 },
      },
    ];
    const [batch] = splitBatches({
      session_url: sessionUrl,
      auxiliary_data: artifacts,
    });
    const post = (body: string) =>
      handle(
        new Request("https://healing.example/api/v1/connection/sessions", {
          method: "POST",
          headers: {
            authorization: "Bearer account-key",
            "content-type": "application/json",
          },
          body,
        }),
      );
    const response = await post(batch!);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).status, "stored");
    const registrations = () =>
      f.calls.filter((call) => call.path === "/api/project-session/register");
    assert.deepEqual(
      (registrations()[0]!.body as { auxiliary_data: unknown }).auxiliary_data,
      artifacts,
    );
    assert.equal((await post(batch!)).status, 200);
    assert.equal(
      registrations().length,
      1,
      "identical package uploads remain idempotent",
    );
    for (const invalid of [
      { ...producer, namespace: "network" },
      { ...producer, key: "unknown" },
      { ...producer, schema_version: 2 },
    ]) {
      const rejected = await post(
        JSON.stringify({ session_url: sessionUrl, auxiliary_data: [invalid] }),
      );
      assert.equal(rejected.status, 400);
    }
    assert.equal(registrations().length, 1, "invalid artifacts never reach QA");
    const spec = getOpenApiSpec().paths["/api/v1/connection/sessions"]!
      .post as {
      requestBody: {
        content: {
          "application/json": {
            schema: {
              properties: {
                auxiliary_data: {
                  items: { properties: { key: { enum: string[] } } };
                };
              };
            };
          };
        };
      };
    };
    assert.ok(
      spec.requestBody.content[
        "application/json"
      ].schema.properties.auxiliary_data.items.properties.key.enum.includes(
        "capture-producer",
      ),
    );
  } finally {
    await f.db.close();
  }
});
