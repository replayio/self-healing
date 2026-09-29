import test from "node:test";
import assert from "node:assert/strict";
import { pipelineData } from "../src/api/pipeline.ts";
import { qaClient } from "../src/api/qa.ts";
import { type Connection, connectionService } from "../src/api/connections.ts";
import { accountService } from "../src/api/accounts.ts";
import { credentialVault } from "../src/api/credentials.ts";
import { HttpError } from "../src/api/errors.ts";
import { createHandler } from "../src/api/handler.ts";
import { getOpenApiSpec } from "../src/api/openapi.ts";

const account = "11111111-1111-4111-8111-111111111111";
const connection = {
  id: "33333333-3333-4333-8333-333333333333",
  account_id: account,
  name: "Example",
  qa_project_id: "qa-one",
  ready: true,
  encrypted_key: "encrypted",
  encrypted_ingest_token: "encrypted",
  production_url: "https://app.example",
  create_attempted: true,
  created_at: new Date(),
  reporting_start_day: new Date(),
} satisfies Connection;
const input = {
  bug_id: "bug-1",
  pr_url: "https://github.com/example/app/pull/42",
  head_sha: "a".repeat(40),
  preview_url: "https://deploy-abc.example",
};
function fixture() {
  let bug = {
    id: "bug-1",
    project_id: "qa-one",
    title: "Checkout fails",
    status: "open",
    severity: "high",
    discovered_at: "2026-09-29T10:00:00Z",
    test_run_id: "run-original" as string | null,
    wontfix_reason: null as string | null,
    replay_recording_id: "recording-1",
    callback_url: "private",
  };
  let source = {
    id: "run-original",
    project_id: "qa-one",
    journey_id: "journey-1",
    journey_version_id: "jv-original",
    journey_steps: { actions: [] } as unknown,
  };
  let journey = { id: "journey-1", project_id: "qa-one" };
  const runs: Record<string, unknown>[] = [];
  const calls: {
    path: string;
    method: string;
    body: Record<string, unknown> | undefined;
  }[] = [];
  let loseCreate = false,
    fail = 0;
  const qa = qaClient(
    { REPLAY_QA_API_TOKEN: "dedicated", REPLAY_QA_URL: "https://qa.example" },
    async (url, init) => {
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer dedicated",
      );
      const u = new URL(String(url));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({
        path: u.pathname + u.search,
        method: init?.method ?? "GET",
        body,
      });
      if (fail) return Response.json({ error: "private" }, { status: fail });
      if (u.pathname === "/api/v1/bugs/bug-1") {
        if (init?.method === "PATCH") bug = { ...bug, ...body };
        return Response.json(bug);
      }
      if (u.pathname === "/api/test-runs/run-original")
        return Response.json(source);
      if (u.pathname === "/api/journeys/journey-1")
        return Response.json(journey);
      if (u.pathname === "/api/test-runs") {
        if (body) {
          const run = {
            ...body,
            id: `run-${runs.length}`,
            created_at: "2026-09-29T12:00:00Z",
            status: "in-progress",
            outcome_status: null,
            outcome_reason: null,
            bugs_found_count: 0,
            environment_variables: { private: true },
          };
          runs.push(run);
          if (loseCreate) throw new Error("lost response");
          return Response.json(run, { status: 201 });
        }
        assert.equal(u.searchParams.get("project_id"), "qa-one");
        assert.equal(u.searchParams.get("journey_id"), "journey-1");
        const offset = (Number(u.searchParams.get("page")) - 1) * 100;
        return Response.json({
          items: runs.slice(offset, offset + 100),
          total: runs.length,
        });
      }
      throw new Error(`Unexpected ${u.pathname}`);
    },
  );
  return {
    data: pipelineData(qa, "https://qa.example"),
    calls,
    runs,
    bug,
    source,
    journey,
    loseCreate: () => {
      loseCreate = true;
    },
    fail: (status: number) => {
      fail = status;
    },
  };
}

test("pipeline reads scoped reports and persists WONTFIX through QA PATCH with a readback", async () => {
  const f = fixture();
  const b = await f.data.bug(connection, "bug-1");
  assert.equal(
    b.fix_reference,
    "https://qa.example/projects/qa-one/bugs/bug-1",
  );
  assert.deepEqual(b.recording_urls, [
    "https://app.replay.io/recording/recording-1",
  ]);
  assert.ok(!JSON.stringify(b).includes("private"));
  const result = await f.data.wontfix(
    connection,
    "bug-1",
    "Expected behavior: the documented limit is enforced.",
  );
  assert.equal(result.status, "wontfix");
  assert.equal(
    result.resolution,
    "Expected behavior: the documented limit is enforced.",
  );
  assert.deepEqual(f.calls.find((c) => c.method === "PATCH")?.body, {
    status: "wontfix",
    wontfix_reason: result.resolution,
  });
  assert.equal(f.calls.at(-1)?.method, "GET");
});

test("verification reruns the original journey version on the preview and retains pending/failure outcomes", async () => {
  const f = fixture();
  const pending = await f.data.verify(connection, input);
  assert.equal(pending.status, "in-progress");
  assert.equal(pending.outcome_status, null);
  const submitted = f.calls.find((c) => c.method === "POST")!.body!;
  assert.equal(submitted.project_id, "qa-one");
  assert.equal(submitted.journey_version_id, "jv-original");
  assert.equal(submitted.override_url, input.preview_url);
  assert.match(
    String(submitted.goal),
    /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/,
  );
  Object.assign(f.runs[0]!, {
    status: "completed",
    outcome_status: "bug",
    bugs_found_count: 1,
    replay_recording_id: "recording-fix",
  });
  const result = await f.data.verifications(connection, "bug-1", 1);
  assert.equal(result.items[0]!.outcome_status, "bug");
  assert.equal(result.items[0]!.bugs_found_count, 1);
  assert.deepEqual(result.items[0]!.recording_urls, [
    "https://app.replay.io/recording/recording-fix",
  ]);
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.ok(!f.calls.some((c) => c.method === "PATCH"));
  Object.assign(f.runs[0]!, {
    status: "completed",
    outcome_status: "passed",
    bugs_found_count: 0,
  });
  assert.equal(
    (await f.data.verifications(connection, "bug-1", 1)).items[0]!
      .outcome_status,
    "passed",
  );
});

test("uncertain create is discoverable without resubmission, and paging ignores unrelated runs", async () => {
  const f = fixture();
  f.loseCreate();
  await assert.rejects(f.data.verify(connection, input), /did not respond/);
  assert.equal(
    (await f.data.verifications(connection, "bug-1", 1)).items[0]!.head_sha,
    input.head_sha,
  );
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 1);
  const saved = f.runs[0]!;
  f.runs.unshift(
    ...Array.from({ length: 100 }, (_, i) => ({
      ...saved,
      id: `unrelated-${i}`,
      goal: "Ordinary QA run",
    })),
  );
  const first = await f.data.verifications(connection, "bug-1", 1);
  assert.deepEqual(first.items, []);
  assert.equal(first.has_more, true);
  assert.equal(
    (await f.data.verifications(connection, "bug-1", 2)).items.length,
    1,
  );
});

test("foreign bugs, source runs, journeys and results never pass account scope", async () => {
  for (const field of ["bug", "source", "journey"] as const) {
    const f = fixture();
    f[field].project_id = "qa-other";
    await assert.rejects(
      f.data.verify(connection, input),
      (e: HttpError) => e.status === 404,
    );
    assert.equal(f.calls.filter((c) => c.method === "POST").length, 0);
  }
  const f = fixture();
  f.bug.project_id = "qa-other";
  await assert.rejects(
    f.data.wontfix(connection, "bug-1", "reason"),
    (e: HttpError) => e.status === 404,
  );
  assert.ok(!f.calls.some((c) => c.method === "PATCH"));
  const g = fixture();
  await g.data.verify(connection, input);
  g.runs[0]!.project_id = "qa-other";
  await assert.rejects(
    g.data.verifications(connection, "bug-1", 1),
    (e: HttpError) => e.status === 404,
  );
});

test("missing reproduction, mismatched targets and failed provider requests are explicit", async () => {
  const f = fixture();
  f.bug.test_run_id = null;
  await assert.rejects(
    f.data.verify(connection, input),
    (e: HttpError) => e.code === "verification_unavailable",
  );
  const g = fixture();
  g.source.journey_steps = null;
  await assert.rejects(
    g.data.verify(connection, input),
    (e: HttpError) => e.code === "verification_unavailable",
  );
  assert.ok(!g.calls.some((c) => c.method === "POST"));
  const h = fixture();
  await h.data.verify(connection, input);
  h.runs[0]!.override_url = "https://production.example";
  await assert.rejects(
    h.data.verifications(connection, "bug-1", 1),
    (e: HttpError) => e.code === "verification_target_mismatch",
  );
  for (const status of [403, 404, 500]) {
    const x = fixture();
    x.fail(status);
    await assert.rejects(
      x.data.bug(connection, "bug-1"),
      (e: HttpError) => e.status === (status === 500 ? 503 : 404),
    );
  }
});

test("HTTP pipeline requires the account bearer, validates inputs and scopes provider work", async () => {
  const vault = credentialVault(Buffer.alloc(32, 1).toString("base64"));
  const query = async () => [];
  const f = fixture();
  const handler = createHandler({
    authenticate: async (req) => {
      if (req.headers.get("authorization") !== "Bearer factory")
        throw new HttpError(401, "unauthorized", "Account key required");
      return { accountId: account };
    },
    accounts: () => ({
      ...accountService(query, vault),
      credentials: async (id) => {
        assert.equal(id, account);
        return { qaToken: "dedicated", subtextKey: "private" };
      },
    }),
    connections: (token) => {
      assert.equal(token, "dedicated");
      return {
        ...connectionService(query, undefined, vault),
        get: async (id) => {
          assert.equal(id, account);
          return connection;
        },
      };
    },
    pipelineData: () => f.data,
  });
  const call = (path: string, body?: unknown, key = true) =>
    handler(
      new Request("https://healing.example/api/v1/connection/" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: "self_healing_dashboard=browser",
          ...(key ? { Authorization: "Bearer factory" } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  assert.equal((await call("bug?bug_id=bug-1", undefined, false)).status, 401);
  for (const body of [
    { bug_id: "bug-1", reason: " " },
    { bug_id: "bug-1", reason: "reason", account_id: account },
  ])
    assert.equal((await call("bugs/wontfix", body)).status, 400);
  for (const body of [
    { ...input, head_sha: "short" },
    { ...input, preview_url: "http://preview.example" },
    { ...input, pr_url: "https://evil.example/pull/1" },
  ])
    assert.equal((await call("bug-verifications", body)).status, 400);
  assert.equal((await call("bug?bug_id=..")).status, 400);
  assert.equal(
    (await call("bug?bug_id=bug-1&project_id=qa-other")).status,
    400,
  );
  assert.equal((await call("bug-verifications", input)).status, 201);
  const result = await call("bug-verifications?bug_id=bug-1&page=1");
  assert.equal(result.status, 200);
  assert.equal((await result.json()).items.length, 1);
  assert.equal(
    (
      await call("bugs/wontfix", {
        bug_id: "bug-1",
        reason: "Documented intended behavior",
      })
    ).status,
    200,
  );
  const spec = getOpenApiSpec();
  const op = spec.paths["/api/v1/connection/bug-verifications"]!.post as {
    security: unknown;
    "x-implementation-status": string;
  };
  assert.deepEqual(op.security, [{ bearerAuth: [] }]);
  assert.equal(op["x-implementation-status"], "implemented");
});

test("OpenAPI identifies required bug IDs and the skill's operations are implemented", () => {
  const spec = getOpenApiSpec();
  for (const path of [
    "/api/v1/connection/bug",
    "/api/v1/connection/bug-verifications",
  ]) {
    const get = spec.paths[path]!.get as {
      parameters: { name: string; required: boolean }[];
    };
    assert.equal(
      get.parameters.find((p) => p.name === "bug_id")?.required,
      true,
    );
  }
});
