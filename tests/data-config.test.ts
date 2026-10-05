import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { dataConfigStore } from "../src/api/data-config.ts";
import { DataConfigInput, ExternalDataConfig } from "../src/api/contracts.ts";
import { credentialVault } from "../src/api/credentials.ts";
import { createHandler } from "../src/api/handler.ts";
import { accountServiceResolver } from "../src/api/account-services.ts";
import { accountService } from "../src/api/accounts.ts";
import { connectionService } from "../src/api/connections.ts";
import { HttpError } from "../src/api/errors.ts";

const a = "00000000-0000-4000-8000-000000000001";
const b = "00000000-0000-4000-8000-000000000002";
const service = {
  endpoint: "https://storage.example/service",
  credential: "PRIVATE_SERVICE_CREDENTIAL",
};
const configuration = ExternalDataConfig.parse({
  mode: "external",
  database: {
    adapter: "neon",
    connection_string:
      "postgresql://user:PRIVATE_DATABASE_PASSWORD@database.example/account",
  },
  artifacts: service,
  recordings: {
    upload: service,
    api: service,
    mcp: service,
    dispatch: { ...service, endpoint: "wss://recordings.example/dispatch" },
  },
});
const input = { expected_revision: 0, configuration };
const unavailable = (e: unknown) => e instanceof HttpError && e.status === 501;

async function fixture() {
  const db = new PGlite();
  for (const name of [
    "004_accounts.sql",
    "009_account_data_config.sql",
    "009_account_data_config.sql",
  ])
    await db.exec(
      await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"),
    );
  const query = async (text: string, values: unknown[]) =>
    (await db.query<Record<string, unknown>>(text, values)).rows;
  for (const id of [a, b])
    await query(
      "INSERT INTO accounts(id, subtext_fingerprint, encrypted_subtext_key, api_key_hash, encrypted_api_key) VALUES ($1,$2,'encrypted',$2,'encrypted')",
      [id, id],
    );
  const vault = credentialVault(Buffer.alloc(32, 7).toString("base64"));
  const configs = dataConfigStore(query, vault);
  const handler = createHandler({
    dataConfigs: () => configs,
    authenticate: async (request) => {
      const id = request.headers.get("authorization")?.replace("Bearer ", "");
      if (id !== a && id !== b)
        throw new HttpError(401, "unauthorized", "Account key required.");
      return { accountId: id };
    },
    accounts: () => {
      throw new Error("External routing must fail before credentials are read");
    },
    connections: () => {
      throw new Error(
        "External routing must fail before constructing adapters",
      );
    },
  });
  const call = (
    method = "GET",
    body?: unknown,
    account: string | null = a,
    path = "/api/v1/account/data-config",
  ) =>
    handler(
      new Request(`https://healing.example${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(account
            ? { Authorization: `Bearer ${account}` }
            : { Cookie: "__Host-sh-dashboard=not-an-account-key" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { db, query, vault, configs, call };
}

test("data-service configuration is encrypted, account-bound, redacted and idempotent", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await (await f.call()).json(), {
      mode: "managed",
      revision: 0,
      availability: "available",
    });
    const response = await f.call("PUT", input);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      mode: "external",
      revision: 1,
      availability: "unsupported",
    });
    const rows = await f.query("SELECT * FROM account_data_configs", []);
    assert.doesNotMatch(
      JSON.stringify(rows),
      /PRIVATE|postgresql|storage\.example|recordings\.example/,
    );
    assert.deepEqual(await f.configs.read(a), {
      mode: "external",
      revision: 1,
      configuration,
    });
    assert.equal((await f.configs.put(a, input)).revision, 1);
    assert.deepEqual(await f.configs.read(b), { mode: "managed", revision: 0 });
    assert.equal(
      (await (await f.call("GET", undefined, b)).json()).mode,
      "managed",
    );
    const publicStatus = await (await f.call()).text();
    assert.doesNotMatch(
      publicStatus,
      /PRIVATE|endpoint|connection_string|credential/,
    );
    // A copied ciphertext/fingerprint cannot be decrypted for another account.
    await f.query(
      "INSERT INTO account_data_configs SELECT $1, revision, fingerprint, encrypted_configuration, updated_at FROM account_data_configs WHERE account_id=$2",
      [b, a],
    );
    await assert.rejects(f.configs.read(b));
  } finally {
    await f.db.close();
  }
});

test("configuration updates use revision checks and reject concurrent stale writers", async () => {
  const f = await fixture();
  try {
    await f.configs.put(a, input);
    const update = (credential: string) => ({
      expected_revision: 1,
      configuration: {
        ...configuration,
        artifacts: { ...service, credential },
      },
    });
    const results = await Promise.allSettled([
      f.configs.put(a, update("next-a")),
      f.configs.put(a, update("next-b")),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const failure = results.find((r) => r.status === "rejected");
    assert.ok(
      failure?.status === "rejected" &&
        failure.reason instanceof HttpError &&
        failure.reason.status === 409,
    );
    assert.equal((await f.configs.status(a)).revision, 2);
    await assert.rejects(
      f.configs.put(a, input),
      (e: unknown) => e instanceof HttpError && e.status === 409,
    );
    await assert.rejects(
      f.configs.put(b, { ...input, expected_revision: 1 }),
      (e: unknown) => e instanceof HttpError && e.status === 409,
    );
  } finally {
    await f.db.close();
  }
});

test("configuration API requires account auth and rejects untrusted account selection and malformed endpoints", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call("PUT", input, null)).status, 401);
    assert.equal((await f.call("GET", undefined, null)).status, 401);
    assert.equal(
      (await f.call("PUT", { ...input, account_id: b })).status,
      400,
    );
    for (const endpoint of [
      "invalid",
      "http://storage.example",
      "https://user:secret@storage.example",
      "https://storage.example/?token=secret",
      "https://storage.example/#secret",
    ]) {
      const body = {
        ...input,
        configuration: {
          ...configuration,
          artifacts: { ...service, endpoint },
        },
      };
      assert.equal((await f.call("PUT", body)).status, 400, endpoint);
    }
    assert.equal(
      DataConfigInput.safeParse({ ...input, expected_revision: 2 ** 40 })
        .success,
      false,
    );
    assert.deepEqual(await f.configs.read(a), { mode: "managed", revision: 0 });
  } finally {
    await f.db.close();
  }
});

test("external accounts fail closed across connection, dashboard and pipeline requests", async () => {
  const f = await fixture();
  try {
    await f.configs.put(a, input);
    for (const path of [
      "/api/v1/connection",
      "/api/v1/connection/reports",
      "/api/v1/dashboard/overview",
      "/api/v1/connection/bugs",
    ]) {
      const response = await f.call("GET", undefined, a, path);
      assert.equal(response.status, 501, path);
      assert.equal(
        (await response.json()).error.code,
        "external_qa_not_implemented",
      );
    }
    const response = await f.call(
      "POST",
      { name: "Example", production_url: "https://example.com" },
      a,
      "/api/v1/connection",
    );
    assert.equal(response.status, 501);
  } finally {
    await f.db.close();
  }
});

test("one account resolver binds every consumer to the same QA client and never falls back on config errors", async () => {
  const f = await fixture();
  try {
    const requests: { url: string; authorization: string | null }[] = [];
    const resolve = accountServiceResolver({
      dataConfigs: () => f.configs,
      accounts: () => ({
        ...accountService(f.query, f.vault),
        credentials: async (id) => ({
          qaToken: `qa-${id}`,
          subtextKey: `subtext-${id}`,
        }),
      }),
      qaOrigin: "https://qa.example",
      request: async (url, init) => {
        requests.push({
          url: String(url),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({});
      },
      connections: (token, qa) => {
        assert.ok(qa);
        assert.ok(token);
        return connectionService(f.query, qa, f.vault);
      },
    });
    const [first, second] = await Promise.all([resolve(a), resolve(b)]);
    await Promise.all([
      first.qa("/api/v1/projects"),
      second.qa("/api/v1/projects"),
    ]);
    assert.deepEqual(requests.map((r) => r.authorization).sort(), [
      `Bearer qa-${a}`,
      `Bearer qa-${b}`,
    ]);
    assert.ok(
      requests.every((r) => r.url === "https://qa.example/api/v1/projects"),
    );
    assert.equal(first.subtextKey, `subtext-${a}`);
    await f.configs.put(a, input);
    await assert.rejects(resolve(a), unavailable);
    assert.equal(requests.length, 2);
    await f.db.exec("DROP TABLE account_data_configs");
    await assert.rejects(resolve(b));
    assert.equal(requests.length, 2);
  } finally {
    await f.db.close();
  }
});
