import test from "node:test";
import assert from "node:assert/strict";
import { createSubtextAuthenticator } from "../src/api/subtext.ts";
import { createHandler } from "../src/api/handler.ts";
import { HttpError } from "../src/api/errors.ts";
const key = "subtext-test-credential";
const request = () =>
  new Request("https://self-healing.example/api/v1/projects", {
    headers: { Authorization: `Bearer ${key}` },
  });
const tools = { tools: [{ name: "example" }] };
const reply = (result: unknown = tools) =>
  Response.json({ jsonrpc: "2.0", id: 1, result });

test("Subtext credential goes only to the fixed provider, with redirects disabled", async () => {
  const authenticate = createSubtextAuthenticator({
    request: async (url, init) => {
      assert.equal(url, "https://api.fullstory.com/mcp/subtext");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${key}`,
      );
      assert.equal(init?.redirect, "error");
      assert.equal(JSON.parse(init?.body as string).method, "tools/list");
      assert.ok(init?.signal);
      return reply();
    },
    resolveIdentity: async (supplied) => {
      assert.equal(supplied, key);
      return { accountId: "provider-account" };
    },
  });
  assert.deepEqual(await authenticate(request()), {
    accountId: "provider-account",
  });
});

test("missing credentials make no upstream request", async () => {
  const authenticate = createSubtextAuthenticator({
    request: async () => {
      throw new Error("must not call");
    },
  });
  await assert.rejects(
    authenticate(new Request("https://example.com")),
    (e: HttpError) => e.status === 401,
  );
});

test("invalid credentials, outages, redirects, and malformed replies never access storage", async () => {
  for (const [response, status] of [
    [new Response("", { status: 401 }), 401],
    [new Response("", { status: 403 }), 401],
    [new Response("", { status: 429 }), 503],
    [new Response("", { status: 500 }), 503],
    [new Response("", { status: 302 }), 503],
    [new Response("not json"), 503],
    [reply({ isError: true }), 503],
    [reply({ ...tools, isError: true }), 503],
    [reply({ ok: false, error: { code: "permission_denied" } }), 401],
    [reply({}), 503],
    [Response.json(null), 503],
  ] as const) {
    const authenticate = createSubtextAuthenticator({
      request: async () => response,
    });
    const handler = createHandler({
      authenticate,
      store: () => {
        assert.fail("must not access storage");
      },
    });
    const result = await handler(request());
    assert.equal(result.status, status);
    assert.ok(!(await result.text()).includes(key));
  }
});

test("verified keys fail closed until a stable Subtext identity resolver exists", async () => {
  for (const result of [tools, { ok: true, data: tools }]) {
    const authenticate = createSubtextAuthenticator({
      request: async () => reply(result),
    });
    await assert.rejects(
      authenticate(request()),
      (error: HttpError) => error.code === "subtext_identity_unavailable",
    );
  }
});

test("key rotation retains provider identity instead of creating a key-hash tenant", async () => {
  const authenticate = createSubtextAuthenticator({
    request: async () => reply(),
    resolveIdentity: async () => ({ accountId: "same-provider-account" }),
  });
  const rotated = new Request("https://example.com", {
    headers: { Authorization: "Bearer rotated-subtext-key" },
  });
  assert.deepEqual(await authenticate(request()), await authenticate(rotated));
});

test("transport and identity resolver failures are sanitized", async () => {
  for (const authenticate of [
    createSubtextAuthenticator({
      request: async () => {
        throw new Error(key);
      },
    }),
    createSubtextAuthenticator({
      request: async () => reply(),
      resolveIdentity: async () => {
        throw new Error(key);
      },
    }),
    createSubtextAuthenticator({
      request: async () => reply(),
      resolveIdentity: async () => ({ accountId: "" }),
    }),
  ])
    await assert.rejects(
      authenticate(request()),
      (e: HttpError) => e.status === 503 && !e.message.includes(key),
    );
});
