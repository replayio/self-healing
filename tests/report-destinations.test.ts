import { managedDataConfigs } from "./helpers/account-services.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createHandler } from "../src/api/handler.ts";
import { connectionService } from "../src/api/connections.ts";
import { credentialVault } from "../src/api/credentials.ts";
import { qaClient } from "../src/api/qa.ts";
import { HttpError } from "../src/api/errors.ts";
import { reportDestinations } from "../src/api/report-destinations.ts";

const slack = "https://hooks.slack.com/services/TEXAMPLE/BEXAMPLE/secret-slack";
const discord = "https://discord.com/api/webhooks/123456/secret-discord";
const endpoint =
  "https://self-healing.example/api/v1/connection/report-destinations";

test("destination routes use the account's QA project and token, preserve other channels, and redact credentials", async () => {
  const db = new PGlite();
  try {
    for (const name of [
      "002_connections.sql",
      "003_session_coordination.sql",
      "006_connection_exploration.sql",
    ])
      await db.exec(
        await readFile(
          new URL(`../migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    const query = async (text: string, values: unknown[]) =>
      (await db.query<Record<string, unknown>>(text, values)).rows;
    for (const [id, account] of [
      ["11111111-1111-4111-8111-111111111111", "a"],
      ["22222222-2222-4222-8222-222222222222", "b"],
    ])
      await query(
        "INSERT INTO connections(id,account_id,encrypted_key,name,production_url,qa_project_id,ready) VALUES($1,$2,'encrypted','Project','https://example.com',$3,true)",
        [id, account, `qa-${account}`],
      );
    const settings: Record<string, Record<string, unknown> | null> = {
      "qa-a": null,
      "qa-b": { email: { recipients: "custom", addresses: ["b@example.com"] } },
    };
    const calls: { project: string; method: string; body?: unknown }[] = [];
    const request: typeof fetch = async (url, init) => {
      const project = new URL(String(url)).pathname.split("/").at(-1)!;
      assert.equal(new URL(String(url)).pathname, `/api/projects/${project}`);
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer token-${project.slice(-1)}`,
      );
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ project, method: init?.method ?? "GET", body });
      if (body) {
        assert.equal(init?.method, "PATCH");
        assert.deepEqual(Object.keys(body).sort(), [
          "action",
          "summary_destinations",
        ]);
        assert.equal(body.action, "update-settings");
        settings[project] = {
          ...settings[project],
          ...body.summary_destinations,
        };
      }
      const saved = settings[project];
      // Include raw secrets to check our boundary even if QA ever forgets redaction.
      return Response.json({
        id: project,
        other_secret: "never-return",
        summary_destinations: saved && {
          ...saved,
          ...(saved.slack
            ? { slack: { ...(saved.slack as object), webhookUrlSet: true } }
            : {}),
          ...(saved.discord
            ? { discord: { ...(saved.discord as object), webhookUrlSet: true } }
            : {}),
        },
      });
    };
    const auth = async (req: Request) => {
      const id = req.headers.get("authorization")?.replace("Bearer ", "");
      if (!["a", "b", "missing"].includes(id ?? ""))
        throw new HttpError(401, "unauthorized", "API key required");
      return { accountId: id! };
    };
    const handler = createHandler({
      dataConfigs: managedDataConfigs,
      authenticate: auth,
      accounts: () => ({
        authenticate: auth,
        credentials: async (id) => ({
          qaToken: `token-${id}`,
          subtextKey: "unused",
        }),
        provisionAccount: async () => {
          throw new Error("not used");
        },
      }),
      connections: (token) =>
        connectionService(
          query,
          qaClient({ REPLAY_QA_API_TOKEN: token }, request),
          credentialVault(Buffer.alloc(32, 3).toString("base64")),
        ),
    });
    const call = (account = "a", body?: unknown, cookie?: string) =>
      handler(
        new Request(endpoint, {
          method: body === undefined ? "GET" : "PATCH",
          headers: {
            ...(account ? { Authorization: `Bearer ${account}` } : {}),
            "Content-Type": "application/json",
            ...(cookie ? { Cookie: cookie } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    assert.deepEqual(await (await call()).json(), {
      email: null,
      slack: null,
      discord: null,
    });
    let response = await call("a", {
      slack: { webhook_url: slack },
      discord: { webhook_url: discord },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      email: null,
      slack: { webhook_url_set: true },
      discord: { webhook_url_set: true },
    });
    response = await call("a", {
      email: { addresses: [" Team@Example.com ", "team@example.com"] },
    });
    const value = await response.json();
    assert.deepEqual(value.email, {
      recipients: "custom",
      addresses: ["team@example.com"],
    });
    assert.equal(value.slack.webhook_url_set, true);
    assert.equal(value.discord.webhook_url_set, true);
    const returned = await (await call()).text();
    assert.ok(!/secret-|never-return|webhookUrl/.test(returned));
    assert.deepEqual((await (await call("b")).json()).email.addresses, [
      "b@example.com",
    ]);
    assert.equal((await call("a", { slack: null })).status, 200);
    assert.equal((await (await call()).json()).slack, null);
    assert.equal((await call("missing", { discord: null })).status, 404);
    assert.equal(
      (await call("", { email: null }, "__Host-sh-dashboard=" + "a".repeat(64)))
        .status,
      401,
    );
    const before = calls.length;
    for (const invalid of [
      {},
      { project_id: "qa-b", email: null },
      { email: { recipients: "owner" } },
      { email: { addresses: [] } },
      { email: { addresses: ["not-email"] } },
      { slack: { webhook_url: discord } },
      { discord: { webhook_url: slack } },
      { slack: { webhook_url: "invalid" } },
      {
        slack: {
          webhook_url: "https://hooks.slack.com.evil.example/services/a/b/c",
        },
      },
      {
        discord: { webhook_url: "http://discord.com/api/webhooks/123/secret" },
      },
    ]) {
      assert.equal(
        (await call("a", invalid)).status,
        400,
        JSON.stringify(invalid),
      );
    }
    assert.equal(calls.length, before, "invalid input must not reach QA");
    await query("UPDATE connections SET ready=false WHERE account_id=$1", [
      "a",
    ]);
    assert.equal((await call("a", { email: null })).status, 409);
    assert.equal(calls.length, before);
  } finally {
    await db.close();
  }
});

test("provider errors and schema drift cannot expose webhook credentials or claim configuration succeeded", async () => {
  for (const raw of [
    { id: "other", summary_destinations: null },
    { id: "qa-a" },
    { id: "qa-a", summary_destinations: { slack: { webhookUrl: slack } } },
  ]) {
    await assert.rejects(
      reportDestinations(async () => raw, "qa-a").read(),
      (error) =>
        error instanceof HttpError &&
        error.status === 503 &&
        !error.message.includes(slack),
    );
  }
  const client = qaClient(
    { REPLAY_QA_API_TOKEN: "token" },
    async () => new Response(slack, { status: 500 }),
  );
  await assert.rejects(
    reportDestinations(client, "qa-a").update({
      slack: { webhook_url: slack },
    }),
    (error) =>
      error instanceof HttpError &&
      error.status === 503 &&
      !error.message.includes(slack),
  );
});
