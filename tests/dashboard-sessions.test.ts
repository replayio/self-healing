import test from "node:test";
import assert from "node:assert/strict";
import { dashboardSessions } from "../src/api/dashboard-sessions.ts";
import { dashboardData } from "../src/api/dashboard-data.ts";
import { QARequestError } from "../src/api/qa.ts";
import { HttpError } from "../src/api/errors.ts";
import type { Connection } from "../src/api/connections.ts";
const connection = { qa_project_id: "project-one" } as Connection;
const session = {
  session_id: "session-one",
  session_url: "https://app.fullstory.com/ui/org/client-session/1:2",
  user_email: null,
  first_received_at: "2026-09-30T00:00:00Z",
  last_received_at: "2026-09-30T01:00:00Z",
};
function fixture(failure?: string, sightmap: Record<string, unknown> = {}) {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const request: typeof fetch = async (url, init) => {
    assert.equal(url, "https://api.fullstory.com/mcp/subtext");
    assert.equal(
      new Headers(init!.headers).get("authorization"),
      "Bearer secret-key",
    );
    const body = JSON.parse(init!.body as string);
    if (body.method !== "initialize")
      assert.equal(
        new Headers(init!.headers).get("mcp-session-id"),
        "private-context",
      );
    let result: unknown = {};
    if (body.method === "tools/list")
      result = {
        tools: [
          {
            name: "review-open",
            inputSchema: { properties: { url: {}, sightmap: {}, memory: {} } },
          },
          {
            name: "review-zoom",
            inputSchema: { properties: { client_id: {}, resolution: {} } },
          },
          {
            name: "review-snapshot",
            inputSchema: {
              properties: {
                client_id: {},
                timestamp: {},
                lens: {},
                include: {},
              },
            },
          },
          {
            name: "review-close",
            inputSchema: {
              properties: { client_id: {}, use_case: {}, was_helpful: {} },
            },
          },
        ],
      };
    if (body.method === "tools/call") {
      const { name, arguments: args } = body.params;
      calls.push(body.params);
      if (name === "review-open") {
        assert.deepEqual(args, { url: session.session_url, ...sightmap });
        result = {
          content: [
            {
              type: "text",
              text: "client_id: review-client\nkinds:\nclick 2 · scroll 1\ntags:\n",
            },
          ],
        };
      } else {
        assert.equal(args.client_id, "review-client");
        assert.equal(args.clientId, undefined);
        if (name === "review-zoom") {
          assert.deepEqual(args.resolution, {
            click: "machine",
            scroll: "machine",
          });
          result = {
            content: [
              {
                type: "text",
                text: '# tab 1 · https://example.com (opened)\n0ms page-load\n100ms click button "Save^changes"\n100ms scroll 100\n200ms network GET /items',
              },
            ],
          };
        }
        if (name === "review-snapshot") {
          assert.equal(args.timestamp, 100);
          assert.deepEqual(args.include, ["image"]);
          assert.equal(args.lens, undefined);
          result = {
            content: [
              { type: "text", text: "[button] Save" },
              { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
              { type: "image", mimeType: "image/svg+xml", data: "unsupported" },
            ],
          };
        }
      }
      if (name === failure)
        result = {
          isError: true,
          content: [{ type: "text", text: "secret provider diagnostic" }],
        };
    }
    const data = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
    return new Response(
      body.method === "tools/call" ? `data: ${data}\n\n` : data,
      { headers: { "mcp-session-id": "private-context" } },
    );
  };
  return { calls, request };
}
test("session day filtering uses UTC half-open boundaries and provider pagination", async () => {
  const service = dashboardSessions(async (path) => {
    const params = new URL(path, "https://qa.example").searchParams;
    assert.equal(params.get("project_id"), "project-one");
    assert.deepEqual(JSON.parse(params.get("query")!), {
      from: "2026-09-30T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
      page: 3,
    });
    return { sessions: [session], page: 3, has_more: true };
  }, "secret");
  assert.deepEqual(await service.sessions(connection, "2026-09-30", 3), {
    sessions: [session],
    page: 3,
    has_more: true,
  });
});
test("session ownership is exact, project-scoped and checked before any Subtext call", async () => {
  let calls = 0;
  const service = dashboardSessions(
    async (path) => {
      const params = new URL(path, "https://qa.example").searchParams;
      assert.equal(params.get("project_id"), "project-one");
      return { sessions: [session], page: 0, has_more: false };
    },
    "secret",
    async () => {
      calls++;
      throw new Error("must not fetch");
    },
  );
  for (const read of [
    () => service.session(connection, "session"),
    () => service.snapshot(connection, "other-session", 100),
  ])
    await assert.rejects(
      read,
      (e: unknown) => e instanceof HttpError && e.status === 404,
    );
  assert.equal(calls, 0);
});
test("Subtext interactions and screenshots use negotiated tools, preserve timeline and close reviews", async () => {
  const f = fixture();
  const service = dashboardSessions(
    async (path) => {
      if (path.endsWith("/sightmap")) throw new QARequestError(404);
      return { sessions: [session], page: 0, has_more: false };
    },
    "secret-key",
    f.request,
  );
  const result = await service.session(connection, session.session_id);
  assert.deepEqual(
    result.interactions.map((e) => e.timestamp),
    [0, 100, 100],
  );
  assert.ok(result.timeline.includes("200ms network"));
  assert.equal(result.interactions[1]!.text, 'click button "Save changes"');
  assert.ok(!JSON.stringify(result).includes("secret-key"));
  assert.equal(f.calls.at(-1)!.name, "review-close");
  const shot = await service.snapshot(connection, session.session_id, 100);
  assert.deepEqual(shot, {
    tree: "",
    images: [{ data: "aW1hZ2U=", mime_type: "image/png" }],
  });
  assert.equal(f.calls.at(-1)!.name, "review-close");
});
test("Subtext failures are explicit and sanitized, and still close the review", async () => {
  const f = fixture("review-zoom");
  const service = dashboardSessions(
    async (path) => {
      if (path.endsWith("/sightmap")) throw new QARequestError(404);
      return { sessions: [session], page: 0, has_more: false };
    },
    "secret-key",
    f.request,
  );
  await assert.rejects(
    service.session(connection, session.session_id),
    (e: unknown) =>
      e instanceof HttpError &&
      e.status === 503 &&
      !e.message.includes("diagnostic"),
  );
  assert.equal(f.calls.at(-1)!.name, "review-close");
});
test("bug sorting is delegated to QA before pagination", async () => {
  const result = await dashboardData(async (path) => {
    const query = new URL(path, "https://qa.example").searchParams;
    assert.equal(query.get("severitySort"), "desc");
    assert.equal(query.get("page"), "2");
    return { items: [], total: 120 };
  }).bugs(connection, 2);
  assert.equal(result.page, 2);
});

test("the connected QA sightmap reaches every review-open, including screenshots", async () => {
  const context = {
    sightmap: [{ name: "Save", selectors: ["button"] }],
    memory: [],
  };
  const f = fixture(undefined, context);
  const service = dashboardSessions(
    async (path) => {
      if (path === "/api/projects/project-one/sightmap")
        return {
          doc: {
            views: [],
            components: [{ name: "Save", selector: "button" }],
          },
        };
      assert.ok(path.includes("project_id=project-one"));
      return { sessions: [session], page: 0, has_more: false };
    },
    "secret-key",
    f.request,
  );
  await service.session(connection, session.session_id);
  await service.snapshot(connection, session.session_id, 100);
  assert.equal(f.calls.filter((call) => call.name === "review-open").length, 2);
});

test("snapshot HTTP failures identify the operation without claiming the session is processing", async () => {
  const f = fixture();
  const service = dashboardSessions(
    async (path) => {
      if (path.endsWith("/sightmap")) throw new QARequestError(404);
      return { sessions: [session], page: 0, has_more: false };
    },
    "secret-key",
    async (url, init) => {
      const body = JSON.parse(init!.body as string);
      if (body.params?.name === "review-snapshot")
        return new Response("secret diagnostic", { status: 429 });
      return f.request(url, init);
    },
  );
  await assert.rejects(
    service.snapshot(connection, session.session_id, 100),
    (error: unknown) =>
      error instanceof HttpError &&
      error.message ===
        "Subtext review-snapshot failed. Too many requests; retry shortly.",
  );
  assert.equal(f.calls.at(-1)!.name, "review-close");
});
