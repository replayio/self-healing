import test from "node:test";
import assert from "node:assert/strict";
import { createQAClient, QARequestError } from "../src/api/qa.ts";
import { HttpError } from "../src/api/errors.ts";

test("explicit QA access is immutable and registration credentials do not change the account credential", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const access = { origin: "https://qa.example", token: "account-token" };
  const qa = createQAClient(access, async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return Response.json({ ok: true });
  });
  access.token = "different-account";
  access.origin = "https://other.example";
  await qa("/api/v1/projects");
  await qa(
    "/api/project-session/register",
    { session_url: "https://example.com/session" },
    "ingest-token",
  );
  await qa("/api/projects/one", { enabled: true }, undefined, "PATCH");
  assert.deepEqual(
    calls.map((c) => new Headers(c.init.headers).get("authorization")),
    ["Bearer account-token", "Bearer ingest-token", "Bearer account-token"],
  );
  assert.ok(
    calls.every(
      (c) =>
        c.url.startsWith("https://qa.example/api/") &&
        c.init.redirect === "error",
    ),
  );
  assert.deepEqual(
    calls.map((c) => c.init.method),
    ["GET", "POST", "PATCH"],
  );
});

test("QA transport rejects invalid origins, missing credentials and normalized path escapes without network access", async () => {
  let calls = 0;
  const request: typeof fetch = async () => {
    calls++;
    return Response.json({});
  };
  for (const origin of [
    "invalid",
    "http://qa.example",
    "https://user:password@qa.example",
    "https://qa.example/api",
    "https://qa.example/?token=x",
  ]) {
    assert.throws(
      () => createQAClient({ origin, token: "secret" }, request),
      (e: unknown) => e instanceof HttpError && e.status === 503,
    );
  }
  const qa = createQAClient(
    { origin: "https://qa.example", token: "secret" },
    request,
  );
  for (const path of [
    "https://other.example/api/",
    "//other.example/api/",
    "/api/../private",
    "/api/%2e%2e/private",
    "/api/..\\private",
    "/api/projects#secret",
  ])
    await assert.rejects(qa(path));
  await assert.rejects(
    createQAClient({ origin: "https://qa.example" }, request)("/api/projects"),
    HttpError,
  );
  assert.equal(calls, 0);
});

test("QA transport never includes upstream response contents or transport secrets in errors", async () => {
  for (const status of [401, 429, 500]) {
    const qa = createQAClient(
      { origin: "https://qa.example", token: "secret" },
      async () => new Response("PRIVATE RESPONSE", { status }),
    );
    await assert.rejects(
      qa("/api/projects"),
      (error: unknown) =>
        error instanceof QARequestError &&
        error.upstreamStatus === status &&
        !error.message.includes("PRIVATE"),
    );
  }
  const qa = createQAClient(
    { origin: "https://qa.example", token: "secret" },
    async () => {
      throw new Error("PRIVATE CREDENTIAL");
    },
  );
  await assert.rejects(
    qa("/api/projects"),
    (error: unknown) =>
      error instanceof HttpError &&
      error.status === 503 &&
      !error.message.includes("PRIVATE"),
  );
});
