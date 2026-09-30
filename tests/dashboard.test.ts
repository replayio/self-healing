import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { dashboardAuth, DASHBOARD_COOKIE } from "../src/api/dashboard-auth.ts";
import { dashboardData } from "../src/api/dashboard-data.ts";
import { createHandler } from "../src/api/handler.ts";
import { accountService } from "../src/api/accounts.ts";
import { connectionService, type Connection } from "../src/api/connections.ts";
import { credentialVault } from "../src/api/credentials.ts";
import { qaClient, QARequestError } from "../src/api/qa.ts";
import { HttpError } from "../src/api/errors.ts";

const origin = "https://healing.example";
const account = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
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
  start_exploration: false,
} satisfies Connection;
async function fixture() {
  const db = new PGlite();
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(await readFile(new URL(file, dir), "utf8"));
  await db.exec(
    await readFile(new URL("005_dashboard_sessions.sql", dir), "utf8"),
  );
  const query = async (text: string, values: unknown[]) =>
    (await db.query<Record<string, unknown>>(text, values)).rows;
  for (const id of [account, other])
    await query(
      "INSERT INTO accounts(id,subtext_fingerprint,encrypted_subtext_key,api_key_hash,encrypted_api_key,encrypted_qa_token) VALUES($1::uuid,$2,'encrypted',$2,'encrypted','encrypted')",
      [id, id],
    );
  return { db, query, auth: dashboardAuth(query, origin) };
}
const cookieRequest = (token: string) =>
  new Request(origin, { headers: { cookie: `${DASHBOARD_COOKIE}=${token}` } });

test("dashboard links open independent browser sessions without consumption or expiry extension", async () => {
  const f = await fixture();
  try {
    const link = await f.auth.launch(account);
    assert.equal(link.session_ttl_seconds, 86400);
    assert.ok(Date.parse(link.expires_at) > Date.now() + 604800000 - 5000);
    assert.ok(Date.parse(link.expires_at) <= Date.now() + 604800000 + 1000);
    const ticket = new URLSearchParams(new URL(link.url).hash.slice(1)).get(
      "ticket",
    )!;
    assert.equal(new URL(link.url).search, "");
    const stored = JSON.stringify(
      await f.query("SELECT * FROM dashboard_sessions", []),
    );
    assert.ok(!stored.includes(ticket));
    await assert.rejects(f.auth.authenticate(cookieRequest(ticket)), HttpError);
    const [token, second] = await Promise.all([
      f.auth.redeem(ticket),
      f.auth.redeem(ticket),
    ]);
    assert.notEqual(token, second);
    assert.deepEqual(await f.auth.authenticate(cookieRequest(second)), {
      accountId: account,
    });
    const [launch] = await f.query(
      "SELECT expires_at FROM dashboard_sessions WHERE kind='launch'",
      [],
    );
    assert.equal((launch!.expires_at as Date).toISOString(), link.expires_at);
    await f.auth.logout(cookieRequest(second));
    await assert.rejects(f.auth.authenticate(cookieRequest(second)), HttpError);
    await assert.rejects(f.auth.redeem(token), HttpError);
    const third = await f.auth.redeem(ticket);
    assert.deepEqual(await f.auth.authenticate(cookieRequest(third)), {
      accountId: account,
    });
    await f.query(
      "UPDATE dashboard_sessions SET expires_at=now()-interval '1 second' WHERE kind='launch'",
      [],
    );
    await assert.rejects(f.auth.redeem(ticket), HttpError);
    // Link expiry and another browser's logout do not end this browser session.
    assert.ok(
      !JSON.stringify(
        await f.query("SELECT * FROM dashboard_sessions", []),
      ).includes(token),
    );
    assert.deepEqual(
      await dashboardAuth(f.query, origin).authenticate(cookieRequest(token)),
      { accountId: account },
    );
    await assert.rejects(
      f.auth.authenticate(cookieRequest(token.slice(1))),
      HttpError,
    );
    const [duration] = await f.query(
      "SELECT EXTRACT(EPOCH FROM expires_at-now()) AS seconds FROM dashboard_sessions WHERE kind='browser'",
      [],
    );
    assert.ok(Number(duration!.seconds) > 86390);
    await f.query(
      "UPDATE dashboard_sessions SET expires_at=now()-interval '1 second'",
      [],
    );
    await assert.rejects(f.auth.authenticate(cookieRequest(token)), HttpError);
    const expired = await f.auth.launch(other);
    await f.query(
      "UPDATE dashboard_sessions SET expires_at=now()-interval '1 second'",
      [],
    );
    await assert.rejects(
      f.auth.redeem(expired.url.split("ticket=")[1]!),
      HttpError,
    );
    const fresh = await f.auth.launch(other);
    const session = await f.auth.redeem(fresh.url.split("ticket=")[1]!);
    assert.deepEqual(await f.auth.authenticate(cookieRequest(session)), {
      accountId: other,
    });
    await f.auth.logout(cookieRequest(session));
    await assert.rejects(
      f.auth.authenticate(cookieRequest(session)),
      HttpError,
    );
  } finally {
    await f.db.close();
  }
});

test("HTTP dashboard cookies are read-only, same-origin, scoped and never substitute for factory keys", async () => {
  const f = await fixture();
  try {
    await f.query(
      "INSERT INTO connections(id,account_id,encrypted_key,name,production_url,qa_project_id,ready) VALUES($1,$2,'encrypted','Example','https://example.com','qa-one',true)",
      [connection.id, account],
    );
    const accounts = accountService(
      f.query,
      credentialVault(Buffer.alloc(32, 1).toString("base64")),
    );
    const providerCalls: string[] = [];
    const handler = createHandler({
      authenticate: async (req) => {
        if (req.headers.get("authorization") !== "Bearer factory-key")
          throw new HttpError(401, "unauthorized", "API key required");
        return { accountId: account };
      },
      accounts: () => ({
        ...accounts,
        credentials: async (id) => {
          assert.equal(id, account);
          return {
            qaToken: "dedicated-qa-token",
            subtextKey: "never-expose-subtext",
          };
        },
      }),
      connections: () =>
        connectionService(
          f.query,
          undefined,
          credentialVault(Buffer.alloc(32, 1).toString("base64")),
        ),
      dashboardAuth: () => f.auth,
      dashboardSessions: (_qa, key) => {
        assert.equal(key, "never-expose-subtext");
        return {
          sessions: async (c, day, page) => {
            assert.equal(c.account_id, account);
            assert.equal(day, "2026-09-30");
            return { sessions: [], page, has_more: false };
          },
          session: async () => {
            throw new HttpError(404, "not_found", "Session not found.");
          },
          snapshot: async () => {
            throw new HttpError(404, "not_found", "Session not found.");
          },
        };
      },
      dashboardData: (qa) => ({
        ...dashboardData(qa),
        bug: async (c, id) => {
          assert.equal(c.account_id, account);
          assert.equal(c.qa_project_id, "qa-one");
          return dashboardData(async () => ({
            ...sampleBug(id),
            project_id: "qa-one",
          })).bug(c, id);
        },
        bugs: async (c) => {
          assert.equal(c.account_id, account);
          providerCalls.push(c.qa_project_id!);
          return { items: [], total: 0, page: 1, has_more: false };
        },
      }),
    });
    const call = (
      path: string,
      options: {
        cookie?: string;
        key?: boolean;
        method?: string;
        body?: unknown;
        origin?: string;
      } = {},
    ) =>
      handler(
        new Request(origin + path, {
          method: options.method ?? "GET",
          headers: {
            "Content-Type": "application/json",
            ...(options.origin ? { Origin: options.origin } : {}),
            ...(options.cookie ? { Cookie: options.cookie } : {}),
            ...(options.key ? { Authorization: "Bearer factory-key" } : {}),
          },
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
        }),
      );
    assert.equal(
      (await call("/api/v1/dashboard-sessions", { method: "POST" })).status,
      401,
    );
    const launch = await call("/api/v1/dashboard-sessions", {
      method: "POST",
      key: true,
    });
    assert.equal(launch.status, 200);
    const { url } = await launch.json();
    const ticket = url.split("ticket=")[1];
    assert.equal(
      (
        await call("/api/v1/dashboard/redeem", {
          method: "POST",
          body: { ticket },
          origin: "https://evil.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call("/api/v1/dashboard/redeem", {
          method: "POST",
          body: { ticket },
        })
      ).status,
      403,
    );
    const malformed = await call("/api/v1/dashboard/redeem", {
      method: "POST",
      body: { ticket: "truncated" },
      origin,
    });
    assert.equal(malformed.status, 400);
    assert.match(
      (await malformed.json()).error.message,
      /incomplete or malformed/,
    );
    const redeemed = await call("/api/v1/dashboard/redeem", {
      method: "POST",
      body: { ticket },
      origin,
    });
    assert.equal(redeemed.status, 200);
    const cookie = redeemed.headers.get("set-cookie")!;
    for (const flag of [
      "Secure",
      "HttpOnly",
      "SameSite=None",
      "Partitioned",
      "Max-Age=86400",
      "Path=/",
    ])
      assert.ok(cookie.includes(flag));
    const read = await call("/api/v1/dashboard/bugs", { cookie });
    assert.equal(read.status, 200);
    assert.ok(read.headers.get("cache-control")!.includes("no-store"));
    assert.equal(read.headers.get("netlify-cdn-cache-control"), "no-store");
    assert.deepEqual(providerCalls, ["qa-one"]);
    assert.ok(!(await read.text()).includes("token"));
    assert.equal(
      (await call("/api/v1/dashboard/sessions?day=2026-09-30", { cookie }))
        .status,
      200,
    );
    for (const path of [
      "/api/v1/dashboard/sessions?day=2026-09-30",
      "/api/v1/dashboard/session?session_id=other",
      "/api/v1/dashboard/session-snapshot?session_id=other&timestamp=1",
    ])
      assert.equal((await call(path)).status, 401);
    for (const path of [
      "/api/v1/dashboard/sessions?day=2026-02-31",
      "/api/v1/dashboard/sessions?day=2026-09-30&project_id=other",
      "/api/v1/dashboard/session",
      "/api/v1/dashboard/session-snapshot?session_id=other&timestamp=-1",
    ])
      assert.equal((await call(path, { cookie })).status, 400);
    assert.equal(
      (await call("/api/v1/dashboard/session?session_id=other", { cookie }))
        .status,
      404,
    );
    const detail = await call("/api/v1/dashboard/bug?bug_id=bug-1", { cookie });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).id, "bug-1");
    assert.equal(
      (await call("/api/v1/dashboard/bug?bug_id=bug-1")).status,
      401,
    );
    for (const query of ["", "?bug_id=..", "?bug_id=bug-1&project_id=qa-two"])
      assert.equal(
        (await call("/api/v1/dashboard/bug" + query, { cookie })).status,
        400,
      );
    assert.equal((await call("/api/v1/connection", { cookie })).status, 401);
    assert.equal(
      (await call("/api/v1/dashboard-sessions", { method: "POST", cookie }))
        .status,
      401,
    );
    assert.equal(
      (await call("/api/v1/projects", { method: "POST", cookie, body: {} }))
        .status,
      401,
    );
    assert.equal(
      (await call("/api/v1/dashboard/bugs?page=0", { cookie })).status,
      400,
    );
    assert.equal(
      (await call("/api/v1/dashboard/bugs?account_id=" + other, { cookie }))
        .status,
      400,
    );
    assert.equal(
      (await call("/api/v1/dashboard/reports?day=2026-02-31", { cookie }))
        .status,
      400,
    );
    assert.equal(
      (
        await call("/api/v1/dashboard/logout", {
          method: "POST",
          cookie,
          origin: "https://evil.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call("/api/v1/dashboard/logout", {
          method: "POST",
          cookie,
          origin,
        })
      ).status,
      200,
    );
    assert.equal(
      (await call("/api/v1/dashboard/bugs", { cookie })).status,
      401,
    );
  } finally {
    await f.db.close();
  }
});

const now = Date.parse("2026-09-29T12:00:00Z");
const sampleBug = (
  id: string,
  status = "open",
  discovered_at = "2026-09-29T10:00:00Z",
) => ({ id, status, discovered_at, title: `Bug ${id}`, severity: "high" });
const run = (
  id: string,
  bugs: { id: string; status: string }[] = [],
  impact?: string,
) => ({
  session_id: id,
  context: { bugs },
  output: {
    observations: impact
      ? [
          { code: "failure", attributes: { impact } },
          { code: "failure", attributes: { impact } },
        ]
      : [],
  },
});
test("overview follows QA pagination, deduplicates sessions and overlaps, and counts UTC days and current bug states", async () => {
  const paths: string[] = [];
  const request = async (path: string) => {
    paths.push(path);
    const url = new URL(path, "https://qa.example"),
      p = url.searchParams;
    assert.equal(p.get("project_id"), "qa-one");
    if (url.pathname === "/api/bugs")
      return p.get("page") === "1"
        ? {
            total: 101,
            resolvedCount: 1,
            items: Array.from({ length: 100 }, (_, i) =>
              sampleBug(String(i), i === 1 ? "reopened" : "open"),
            ),
          }
        : {
            total: 101,
            resolvedCount: 1,
            items: [sampleBug("old", "open", "2026-09-01T00:00:00Z")],
          };
    if (p.get("summary"))
      return {
        reviewers: [
          { key: "friction-and-recovery" },
          { key: "goals-and-outcomes" },
        ],
      };
    if (p.get("sessions")) {
      const query = JSON.parse(p.get("query")!);
      assert.equal(query.from, "2026-08-31T00:00:00.000Z");
      return {
        has_more: query.page === 0,
        sessions:
          query.page === 0
            ? [
                { session_id: "a", first_received_at: "2026-09-29T01:00:00Z" },
                { session_id: "b", first_received_at: "2026-09-29T02:00:00Z" },
              ]
            : [
                { session_id: "a", first_received_at: "2026-09-29T01:00:00Z" },
                {
                  session_id: "c",
                  first_received_at: "2026-09-29T00:00:00+03:00",
                },
              ],
      };
    }
    if (!p.get("filter")) return { totals: { total_sessions: 105 } };
    return {
      totals: { total_sessions: 3 },
      deleted_codes: [],
      has_more:
        p.get("reviewer") === "friction-and-recovery" && p.get("page") === "0",
      runs:
        p.get("reviewer") === "friction-and-recovery"
          ? p.get("page") === "0"
            ? [run("a", [{ id: "0", status: "open" }], "blocked")]
            : [
                run("b", [], "delayed"),
                run(
                  "c",
                  [{ id: "unconfirmed", status: "judge-rejected" }],
                  "blocked",
                ),
              ]
          : [
              run("a", [{ id: "0", status: "open" }]),
              run("b", [{ id: "old", status: "fixed" }]),
            ],
    };
  };
  const result = await dashboardData(request, now).overview(connection);
  assert.equal(result.sessions, 105);
  assert.equal(result.open_bugs, 101);
  assert.equal(result.closed_bugs, 1);
  assert.equal(result.new_open_bugs, 100);
  assert.equal(result.days.length, 30);
  assert.deepEqual(result.days.at(-1), {
    day: "2026-09-29",
    sessions: 2,
    reviewed_sessions: 2,
    bug_sessions: 2,
    serious_sessions: 1,
    both_sessions: 1,
  });
  assert.deepEqual(result.days.at(-2), {
    day: "2026-09-28",
    sessions: 1,
    reviewed_sessions: 1,
    bug_sessions: 0,
    serious_sessions: 1,
    both_sessions: 0,
  });
  assert.equal(paths.filter((p) => p.startsWith("/api/bugs")).length, 2);
});

test("reports adapt QA opened_at and retain evidence bug links without exposing reviewer or provider details", async () => {
  const data = dashboardData(async (path) => {
    const p = new URL(path, "https://qa.example").searchParams;
    assert.equal(p.get("id"), connection.id);
    assert.equal(p.get("project_id"), connection.qa_project_id);
    assert.equal(p.get("day"), "2026-09-28");
    const { discovered_at, ...b } = sampleBug("bug-example");
    return {
      older: "2026-09-26",
      newer: "2026-09-29",
      latest_attempt: { day: "2026-09-29", status: "queued" },
      run: {
        day: "2026-09-28",
        timezone: "UTC",
        status: "completed",
        sessions: 20,
        reviewed_sessions: 12,
        output: {
          overview: "Checkout errors",
          findings: [
            {
              category: "Friction",
              text: "Users could not pay.",
              source_ids: ["review-1"],
            },
          ],
        },
        bugs: [
          {
            ...b,
            opened_at: discovered_at,
            is_duplicate: false,
            impacted_sessions: 2,
          },
        ],
        review_evidence: [
          {
            id: "review-1",
            bugs: [{ id: b.id }],
            user_email: "private@example.com",
            session_url: "private-session",
          },
        ],
        sources: [{ secret: "not-forwarded" }],
      },
    };
  });
  const result = await data.reports(connection, "2026-09-28");
  assert.equal(result.run!.bugs[0]!.url, "/dashboard?tab=bugs&bug=bug-example");
  assert.equal(result.run!.output!.findings[0]!.bugs[0]!.id, "bug-example");
  assert.equal(result.older, "2026-09-26");
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.ok(!JSON.stringify(result).includes("not-forwarded"));
});

test("dashboard uses dedicated QA bearer and fails visibly on malformed or failed upstream responses", async () => {
  const qa = qaClient(
    {
      REPLAY_QA_API_TOKEN: "qa-dedicated",
      REPLAY_QA_URL: "https://qa.example",
    },
    async (_url, init) => {
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer qa-dedicated",
      );
      return Response.json({ items: [], total: 0 });
    },
  );
  assert.deepEqual(await dashboardData(qa).bugs(connection, 2), {
    items: [],
    total: 0,
    page: 2,
    has_more: false,
  });
  await assert.rejects(
    dashboardData(async () => ({ items: [] })).bugs(connection, 1),
    /unexpected dashboard data/,
  );
  await assert.rejects(
    dashboardData(async () => {
      throw new HttpError(503, "qa_unavailable", "Unavailable");
    }).overview(connection),
    /Unavailable/,
  );
});

test("bug lists expose QA kinds and fix PRs with local report URLs", async () => {
  const result = await dashboardData(async () => ({
    total: 3,
    items: [
      {
        ...sampleBug("polish"),
        polish_category: "security",
        test_run_id: "run",
        fix_prs: [
          {
            repo_full_name: "replayio/example",
            pr_number: 42,
            pr_state: "closed",
            merged_at: "2026-09-29T00:00:00Z",
            verification_detail: "private",
          },
        ],
      },
      { ...sampleBug("test"), test_run_id: "run" },
      sampleBug("legacy"),
    ],
  })).bugs(connection, 1);
  assert.deepEqual(
    result.items.map((b) => b.kind),
    ["security", "testing", null],
  );
  assert.equal(result.items[0]!.url, "/dashboard?tab=bugs&bug=polish");
  assert.deepEqual(result.items[0]!.fix_prs, [
    {
      repo_full_name: "replayio/example",
      pr_number: 42,
      state: "merged",
      url: "https://github.com/replayio/example/pull/42",
    },
  ]);
  assert.deepEqual(result.items[1]!.fix_prs, []);
});

test("bug detail checks project ownership and returns report content without provider metadata", async () => {
  const raw = {
    ...sampleBug("bug-1"),
    project_id: "qa-one",
    description: "Description",
    reproduction_steps: "Click checkout",
    expected_behavior: "Payment succeeds",
    actual_behavior: "Payment fails",
    notes: "Note",
    wontfix_reason: null,
    callback_url: "private",
    analysis: {
      root_cause: {
        text: "Root cause",
        evidence: [
          {
            tool: "ReadSource",
            params: { path: "src/checkout.ts" },
            result: "Source evidence",
          },
        ],
      },
      chain: [
        {
          text: "Cause",
          secret: "private",
          evidence: [
            { tool: "Evaluate", params: { expression: "total" }, result: "0" },
          ],
        },
      ],
      chronology: [
        {
          text: "Click",
          evidence: [
            {
              tool: "Screenshot",
              result:
                "https://static.replay.io/recordings/recording/analysis/screenshot-100.jpg",
              params: { time: 100 },
            },
          ],
        },
      ],
    },
  };
  const data = dashboardData(async (path) => {
    assert.equal(path, "/api/bugs/bug-1");
    return raw;
  });
  const result = await data.bug(connection, "bug-1");
  assert.equal(result.description, "Description");
  assert.equal(result.analysis?.root_cause?.text, "Root cause");
  assert.deepEqual(
    result.analysis?.root_cause?.evidence,
    raw.analysis.root_cause.evidence,
  );
  assert.deepEqual(
    result.analysis?.chain?.[0]?.evidence,
    raw.analysis.chain[0]!.evidence,
  );
  assert.deepEqual(
    result.analysis?.chronology?.[0]?.evidence,
    raw.analysis.chronology[0]!.evidence,
  );
  assert.equal(
    result.analysis?.chronology?.[0]?.screenshot_url,
    "https://static.replay.io/recordings/recording/analysis/screenshot-100.jpg",
  );
  assert.ok(!JSON.stringify(result).includes("private"));
  await assert.rejects(
    data.bug({ ...connection, qa_project_id: "qa-two" }, "bug-1"),
    (e: HttpError) => e.status === 404,
  );
  await assert.rejects(
    dashboardData(async () => ({ ...raw, id: "another" })).bug(
      connection,
      "bug-1",
    ),
    (e: HttpError) => e.status === 404,
  );
  for (const status of [403, 404, 500])
    await assert.rejects(
      dashboardData(async () => {
        throw new QARequestError(status);
      }).bug(connection, "bug-1"),
      (e: HttpError) => e.status === (status === 500 ? 503 : 404),
    );
});

test("deployment permits dashboard framing and partitioned logout clears the browser cookie", async () => {
  const config = await readFile(
    new URL("../netlify.toml", import.meta.url),
    "utf8",
  );
  const rules = config.split("[[headers]]").slice(1);
  const embedding = rules.filter((rule) =>
    rule.includes('Content-Security-Policy = "frame-ancestors *"'),
  );
  assert.equal(embedding.length, 2);
  assert.ok(embedding.some((rule) => rule.includes('for = "/dashboard"')));
  assert.ok(embedding.some((rule) => rule.includes('for = "/dashboard/"')));
  assert.ok(
    rules.some(
      (rule) =>
        rule.includes('for = "/*"') &&
        rule.includes('X-Frame-Options = "DENY"'),
    ),
  );
  const { dashboardCookie } = await import("../src/api/dashboard-auth.ts");
  const cleared = dashboardCookie("", 0);
  for (const attribute of [
    "Secure",
    "HttpOnly",
    "SameSite=None",
    "Partitioned",
    "Path=/",
    "Max-Age=0",
  ])
    assert.ok(cleared.includes(attribute));
});
