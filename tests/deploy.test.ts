import test from "node:test";
import assert from "node:assert/strict";
import {
  deploymentConfig,
  productionValues,
  syncRuntimeSecrets,
  target,
  netlifyApi,
} from "../scripts/lib/deploy.ts";
const env = {
  NETLIFY_AUTH_TOKEN: "deployment-token",
  NETLIFY_SITE_ID: target.siteId,
  NETLIFY_ACCOUNT_SLUG: target.accountSlug,
  DATABASE_URL: `postgresql://user:secret@${target.databaseHost}/neondb?sslmode=require`,
};

test("deployment refuses missing configuration or the wrong site/database before side effects", () => {
  assert.equal(deploymentConfig(env).siteId, target.siteId);
  for (const override of [
    { NETLIFY_SITE_ID: "qa-site" },
    { NETLIFY_ACCOUNT_SLUG: "another-team" },
    { DATABASE_URL: "postgresql://user:secret@qa.example/db" },
    { NETLIFY_AUTH_TOKEN: "" },
  ]) {
    assert.throws(() => deploymentConfig({ ...env, ...override }));
  }
  assert.equal(
    deploymentConfig({
      ...env,
      DATABASE_URL: env.DATABASE_URL.replace(".c-4.", "-pooler.c-4."),
    }).siteId,
    target.siteId,
  );
});

test("production environment replacement preserves preview overrides without a shared fallback", () => {
  assert.deepEqual(
    productionValues(
      [
        { context: "production", value: "old" },
        { context: "all", value: "unsafe-fallback" },
        { context: "branch-deploy", value: "preview" },
      ],
      "new",
    ),
    [
      { context: "branch-deploy", value: "preview" },
      { context: "production", value: "new" },
    ],
  );
});

test("only the database is synced to production functions; retired keys are removed", async () => {
  const writes: { url: string; method: string; body: unknown }[] = [];
  await syncRuntimeSecrets(deploymentConfig(env), async (url, init) => {
    const path = String(url);
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer deployment-token",
    );
    if (path.endsWith(`/sites/${target.siteId}`))
      return Response.json({
        account_slug: "replay",
        custom_domain: target.domain,
      });
    if (init?.method === "GET")
      return Response.json([
        {
          key: "DATABASE_URL",
          scopes: ["builds", "functions"],
          values: [{ context: "production", value: "old" }],
        },
        { key: "SELF_HEALING_API_KEYS", scopes: ["functions"], values: [] },
      ]);
    writes.push({
      url: path,
      method: init!.method!,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return new Response(null, { status: 204 });
  });
  assert.equal(writes.length, 2);
  assert.equal(writes[0]!.method, "PUT");
  assert.deepEqual(writes[0]!.body, {
    key: "DATABASE_URL",
    scopes: ["functions"],
    values: [{ context: "production", value: env.DATABASE_URL }],
  });
  assert.equal(writes[1]!.method, "DELETE");
  assert.match(writes[1]!.url, /SELF_HEALING_API_KEYS/);
});

test("a fresh site creates its runtime variable and refuses domain mismatches", async () => {
  let created = false;
  await syncRuntimeSecrets(deploymentConfig(env), async (url, init) => {
    if (String(url).includes("/sites/"))
      return Response.json({
        account_slug: "replay",
        custom_domain: target.domain,
      });
    if (init?.method === "GET") return Response.json([]);
    assert.equal(init?.method, "POST");
    assert.ok(Array.isArray(JSON.parse(init.body as string)));
    created = true;
    return Response.json([]);
  });
  assert.ok(created);
  await assert.rejects(
    syncRuntimeSecrets(deploymentConfig(env), async () =>
      Response.json({ account_slug: "replay", custom_domain: "qa.replay.io" }),
    ),
    /does not match/,
  );
});

test("Netlify errors do not expose raw provider response bodies or secrets", async () => {
  const api = netlifyApi(
    "secret",
    async () => new Response("secret connection URL", { status: 403 }),
  );
  await assert.rejects(
    api("/example"),
    (error) =>
      error instanceof Error &&
      error.message === "Netlify GET request returned HTTP 403",
  );
});

test("only explicit connection runtime settings are synced, never Infisical or customer credentials", async () => {
  const keys: string[] = [];
  const config = deploymentConfig({
    ...env,
    SELF_HEALING_SECRET: "encrypted-root",
    LOOPQA_ADMIN_TOKEN: "qa-token",
    REPLAY_QA_URL: "https://qa.replay.io",
    SELF_HEALING_URL: "https://replay-self-healing.netlify.app",
    INFISICAL_MACHINE_IDENTITY_CLIENT_SECRET: "do-not-export",
    SUBTEXT_API_KEY: "customer-key",
  });
  await syncRuntimeSecrets(config, async (url, init) => {
    if (String(url).includes("/sites/"))
      return Response.json({
        account_slug: "replay",
        custom_domain: target.domain,
      });
    if (init?.method === "GET") return Response.json([]);
    for (const item of JSON.parse(String(init?.body))) {
      keys.push(item.key);
      assert.deepEqual(item.scopes, ["functions"]);
      assert.equal(item.values[0].context, "production");
    }
    return new Response(null, { status: 204 });
  });
  assert.deepEqual(keys.sort(), [
    "DATABASE_URL",
    "LOOPQA_ADMIN_TOKEN",
    "REPLAY_QA_URL",
    "SELF_HEALING_SECRET",
    "SELF_HEALING_URL",
  ]);
});
