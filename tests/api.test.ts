import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createHandler } from "../src/api/handler.ts";
import { createStore, type Store } from "../src/api/store.ts";
import {
  configurations,
  ErrorResponse,
  operations,
  Project,
} from "../src/api/contracts.ts";
import { HttpError } from "../src/api/errors.ts";
import { getOpenApiSpec } from "../src/api/openapi.ts";

const db = new PGlite();
const migration = await readFile(
  new URL("../migrations/001_initial.sql", import.meta.url),
  "utf8",
);
await db.exec(migration);
await db.exec(migration); // Bootstrap migration can be retried.
after(() => db.close());
const keyA = "a".repeat(64),
  keyB = "b".repeat(64);
// Test-only stand-in for provider-verified identity. No key map exists in production.
const authenticate = async (request: Request) => {
  const key = request.headers.get("authorization")?.replace("Bearer ", "");
  if (key === keyA) return { accountId: "account-a" };
  if (key === keyB) return { accountId: "account-b" };
  throw new HttpError(401, "unauthorized", "Invalid Subtext key");
};
const store = createStore(
  async (text, values) =>
    (await db.query<Record<string, unknown>>(text, values)).rows,
);
const handler = createHandler({ store: () => store, authenticate });
const input = {
  name: "Example",
  repository_url: "https://github.com/example/app",
  production_url: "https://app.example.com",
};
async function call(
  path: string,
  method = "GET",
  body?: unknown,
  key: string | null = keyA,
  handle = handler,
) {
  return handle(
    new Request(`https://self-healing.example/api/v1${path}`, {
      method,
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function create() {
  const response = await call("/projects", "POST", input);
  assert.equal(response.status, 201);
  return Project.parse(await response.json());
}

test("discovery and health need no credentials or database", async () => {
  const isolated = createHandler({
    store: () => {
      throw new Error("no database");
    },
    authenticate: async () => {
      throw new HttpError(503, "subtext_unavailable", "Unavailable");
    },
  });
  for (const path of ["/health", "/openapi.json"]) {
    const response = await call(path, "GET", undefined, null, isolated);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(
    (await call("/projects", "GET", undefined, keyA, isolated)).status,
    503,
  );
});

test("authentication fails closed and has a stable error envelope", async () => {
  for (const key of [null, "wrong"]) {
    const response = await call("/projects", "GET", undefined, key);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
    const body = ErrorResponse.parse(await response.json());
    assert.equal(body.error.request_id, response.headers.get("x-request-id"));
  }
});

test("project create/read/patch persists across handlers without leaking account identity", async () => {
  const project = await create();
  assert.equal(project.default_branch, "main");
  const secondHandler = createHandler({
    store: () =>
      createStore(
        async (text, values) =>
          (await db.query<Record<string, unknown>>(text, values)).rows,
      ),
    authenticate,
  });
  const response = await call(
    `/projects/${project.id}`,
    "PATCH",
    { name: "Updated" },
    keyA,
    secondHandler,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).name, "Updated");
  const saved = await (await call(`/projects/${project.id}`)).json();
  assert.equal(saved.name, "Updated");
  assert.equal("account_id" in saved, false);
  assert.equal(saved.default_branch, "main");
});

test("account isolation covers project reads, updates, lists and configuration", async () => {
  const project = await create();
  for (const [method, suffix, body] of [
    ["GET", "", undefined],
    ["PATCH", "", { name: "Stolen" }],
    ["GET", "/integrations", undefined],
    ["PUT", "/integrations", { replay_project_id: "stolen" }],
  ] as const) {
    assert.equal(
      (await call(`/projects/${project.id}${suffix}`, method, body, keyB))
        .status,
      404,
    );
  }
  const list = await (await call("/projects", "GET", undefined, keyB)).json();
  assert.deepEqual(list.items, []);
  assert.equal((await store.get("account-a", project.id))!.name, "Example");
});

test("all configuration resources persist, replace atomically, and validate", async () => {
  const project = await create();
  const samples = {
    integrations: {
      replay_project_id: "replay-project",
      subtext_project_id: "subtext-project",
    },
    context: {
      documents: [{ title: "Requirements", content: "Checkout must work" }],
    },
    sightmap: {
      commit_sha: "a".repeat(40),
      entries: [
        {
          path: "src/checkout.tsx",
          purpose: "Checkout",
          routes: ["/checkout"],
        },
      ],
    },
    environments: {
      environments: [
        {
          name: "Production",
          url: input.production_url,
          kind: "production",
          qa_enabled: true,
          schedule: "daily",
        },
      ],
      test_pull_requests: true,
    },
    "report-settings": {
      enabled: true,
      cadence: "weekly",
      hour_utc: 10,
      destinations: [{ type: "email", address: "team@example.com" }],
    },
  };
  for (const kind of Object.keys(
    configurations,
  ) as (keyof typeof configurations)[]) {
    const path = `/projects/${project.id}/${kind}`;
    assert.equal((await call(path)).status, 404);
    const expected = configurations[kind].parse(samples[kind]);
    assert.equal((await call(path, "PUT", samples[kind])).status, 200);
    assert.deepEqual(await (await call(path)).json(), expected);
    assert.equal((await call(path, "PUT", { unknown: true })).status, 400);
    assert.deepEqual(await (await call(path)).json(), expected);
  }
  const path = `/projects/${project.id}/integrations`;
  await call(path, "PUT", { fullstory_org_id: "org" });
  assert.deepEqual(await (await call(path)).json(), {
    fullstory_org_id: "org",
  });
  // The FK also enforces account ownership if future callers bypass the handler.
  await assert.rejects(
    store.putConfiguration("account-b", project.id, "integrations", {}),
  );
});

test("project pagination is bounded with exclusive cursors", async () => {
  await create();
  await create();
  const first = await (await call("/projects?limit=1")).json();
  assert.equal(first.items.length, 1);
  assert.equal(first.next_cursor, first.items[0].id);
  const second = await (
    await call(`/projects?limit=100&cursor=${first.next_cursor}`)
  ).json();
  assert.ok(second.items.length > 0);
  assert.ok(
    second.items.every((item: { id: string }) => item.id > first.next_cursor),
  );
  assert.equal(second.next_cursor, null);
  for (const query of [
    "limit=0",
    "limit=101",
    "cursor=invalid",
    "unexpected=true",
  ]) {
    assert.equal((await call(`/projects?${query}`)).status, 400);
  }
});

test("invalid JSON, identifiers, empty patches, unknown fields and protocols are rejected", async () => {
  assert.equal(
    (
      await handler(
        new Request("https://example.com/api/v1/projects", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${keyA}`,
            "Content-Type": "application/json",
          },
          body: "{",
        }),
      )
    ).status,
    400,
  );
  assert.equal((await call("/projects/not-a-uuid")).status, 400);
  assert.equal(
    (
      await call("/projects", "POST", {
        ...input,
        production_url: "javascript:alert(1)",
      })
    ).status,
    400,
  );
  assert.equal(
    (await call("/projects", "POST", { ...input, account_id: "account-b" }))
      .status,
    400,
  );
  assert.equal(
    (await call(`/projects/${(await create()).id}`, "PATCH", {})).status,
    400,
  );
});

test("content type is enforced without a separate server request-size limit", async () => {
  const request = (body: string, contentType: string) =>
    new Request("https://example.com/api/v1/projects", {
      method: "POST",
      headers: { Authorization: `Bearer ${keyA}`, "Content-Type": contentType },
      body,
    });
  assert.equal((await handler(request("{}", "text/plain"))).status, 415);
  assert.equal(
    (
      await handler(
        request(
          " ".repeat(2_000_000) + JSON.stringify(input),
          "application/json",
        ),
      )
    ).status,
    201,
  );
});

test("unimplemented provider operations never report successful queued work", async () => {
  const id = (await create()).id;
  for (const operation of operations.filter(
    (item) => !item.implemented && !item.body,
  )) {
    const path = operation.path
      .replace("/api/v1", "")
      .replace(/\{[^}]+\}/g, id);
    const response = await call(path, operation.method);
    assert.equal(response.status, 501, operation.id);
    assert.equal((await response.json()).error.code, "not_implemented");
    assert.equal(
      (await call(path, operation.method, undefined, null)).status,
      401,
    );
  }
  assert.equal(
    (
      await call(`/projects/${id}/qa/runs`, "POST", {
        kind: "pull_request",
        target_url: input.production_url,
        commit_sha: "a".repeat(40),
      })
    ).status,
    400,
  );
  const result = await call(`/projects/${id}/qa/runs`, "POST", {
    kind: "release",
    target_url: input.production_url,
    commit_sha: "a".repeat(40),
  });
  assert.equal(result.status, 501);
});

test("unknown routes and unsupported methods return JSON, never the landing page", async () => {
  const unknown = await call("/unknown");
  assert.equal(unknown.status, 404);
  ErrorResponse.parse(await unknown.json());
  const method = await call("/projects", "DELETE");
  assert.equal(method.status, 405);
  assert.match(method.headers.get("allow")!, /GET/);
});

test("database failures do not expose connection strings or SQL", async () => {
  const broken = createHandler({
    authenticate,
    store: () =>
      ({
        ...store,
        list: async () => {
          throw new Error("postgresql://secret:password@host");
        },
      }) as Store,
  });
  const response = await call("/projects", "GET", undefined, keyA, broken);
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /secret|password|postgresql/);
});

test("OpenAPI describes every operation, implementation status, authentication, and schemas", () => {
  const spec = getOpenApiSpec();
  assert.equal(
    new Set(operations.map((item) => item.id)).size,
    operations.length,
  );
  for (const operation of operations) {
    const documented = spec.paths[operation.path]![
      operation.method.toLowerCase()
    ] as Record<string, any>;
    assert.equal(documented.operationId, operation.id);
    assert.deepEqual(
      documented.security,
      operation.public
        ? []
        : operation.dashboard
          ? [{ dashboardCookie: [] }, { bearerAuth: [] }]
          : [{ bearerAuth: [] }],
    );
    assert.ok(
      documented.responses[String(operation.status ?? 200)].content[
        "application/json"
      ].schema,
    );
    assert.ok(
      documented.responses["501"],
      "unsupported account adapters are explicit even on implemented routes",
    );
    if (operation.body)
      assert.ok(documented.requestBody.content["application/json"].schema);
  }
});

test("generated OpenAPI passes an independent specification validator", async () => {
  const { default: SwaggerParser } =
    await import("@apidevtools/swagger-parser");
  await SwaggerParser.validate(JSON.parse(JSON.stringify(getOpenApiSpec())));
});
