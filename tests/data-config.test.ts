import test from "node:test";
import assert from "node:assert/strict";
import { dataConfigStore } from "../src/api/data-config.ts";
import { ExternalDataConfig } from "../src/api/contracts.ts";
import { createQAClient, QARequestError } from "../src/api/qa.ts";
import { createHandler } from "../src/api/handler.ts";
import { accountServiceResolver } from "../src/api/account-services.ts";
import { HttpError } from "../src/api/errors.ts";

const a = "00000000-0000-4000-8000-000000000001";
const b = "00000000-0000-4000-8000-000000000002";
const service = { endpoint: "https://storage.example/service", credential: "PRIVATE_CREDENTIAL" };
const configuration = ExternalDataConfig.parse({
  mode: "external", retention: "zero",
  database: { adapter: "neon", connection_string: "postgresql://user:PRIVATE_PASSWORD@database.example/account" },
  artifacts: service,
  recordings: { upload: service, api: service, mcp: service, dispatch: { ...service, endpoint: "wss://recordings.example/dispatch" } },
});
const input = { expected_revision: 0, configuration };
const managed = { mode: "managed", revision: 0, availability: "available" };
const external = { mode: "external", retention: "zero", revision: 1, availability: "unsupported" };

function fixture() {
  const calls: { account: string; path: string; method: string; body: unknown }[] = [];
  const configured = new Set<string>();
  const configs = dataConfigStore(async account => createQAClient({ origin: "https://qa.example", token: `qa-${account}` }, async (url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer qa-${account}`);
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ account, path: String(url), method: init!.method!, body });
    if (init?.method === "PUT") configured.add(account);
    return Response.json(configured.has(account) ? external : managed);
  }));
  const handler = createHandler({
    dataConfigs: () => configs,
    authenticate: async request => {
      const id = request.headers.get("authorization")?.replace("Bearer ", "");
      if (id !== a && id !== b) throw new HttpError(401, "unauthorized", "Account key required.");
      return { accountId: id };
    },
    accounts: () => { throw new Error("Must not construct account-work adapters"); },
    connections: () => { throw new Error("Must not construct account-work adapters"); },
  });
  const call = (method = "GET", body?: unknown, account: string | null = a, path = "/api/v1/account/data-config") => handler(new Request(`https://healing.example${path}`, {
    method, headers: { "Content-Type": "application/json", ...(account ? { Authorization: `Bearer ${account}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { configs, calls, call };
}

test("configuration API forwards to QA with account-bound credentials and returns redacted status", async () => {
  const f = fixture();
  assert.deepEqual(await (await f.call()).json(), managed);
  assert.deepEqual(await (await f.call("PUT", input)).json(), external);
  assert.deepEqual(f.calls[1], { account: a, path: "https://qa.example/api/account-data-config", method: "PUT", body: input });
  assert.deepEqual(await (await f.call("GET", undefined, b)).json(), managed);
  assert.doesNotMatch(await (await f.call()).text(), /PRIVATE|endpoint|connection_string|credential/);
});

test("configuration API rejects unauthenticated requests and client account selection before forwarding", async () => {
  const f = fixture();
  assert.equal((await f.call("PUT", input, null)).status, 401);
  assert.equal((await f.call("PUT", { ...input, account_id: b })).status, 400);
  assert.equal((await f.call("PUT", { ...input, configuration: { ...configuration, artifacts: { ...service, endpoint: "http://unsafe.example" } } })).status, 400);
  assert.equal(f.calls.length, 0);
});

test("QA configuration errors and conflicts propagate without a local fallback or successful fake write", async () => {
  for (const status of [404, 409, 503]) {
    const configs = dataConfigStore(async () => createQAClient({ origin: "https://qa.example", token: "token" }, async () => new Response("PRIVATE", { status })));
    await assert.rejects(configs.status(a), error => error instanceof QARequestError && error.upstreamStatus === status);
    await assert.rejects(configs.put(a, input), error => error instanceof QARequestError && error.upstreamStatus === status);
  }
  const malformed = dataConfigStore(async () => async () => ({ ...external, credential: "PRIVATE" }));
  await assert.rejects(malformed.status(a));
});

test("QA's persisted external policy blocks Self Healing connection, dashboard and pipeline work", async () => {
  const f = fixture();
  await f.configs.put(a, input);
  for (const path of ["/api/v1/connection", "/api/v1/connection/reports", "/api/v1/dashboard/overview", "/api/v1/connection/bugs"]) {
    const response = await f.call("GET", undefined, a, path);
    assert.equal(response.status, 501, path);
    assert.equal((await response.json()).error.code, "external_qa_not_implemented");
  }
});

test("service resolution cannot proceed when QA's account directory is unavailable", async () => {
  const resolve = accountServiceResolver({ dataConfigs: () => ({
    status: async () => { throw new Error("directory unavailable"); },
    put: async () => { throw new Error("not used"); },
  }), accounts: () => { throw new Error("Must not read work credentials"); } });
  await assert.rejects(resolve(a), /directory unavailable/);
});
