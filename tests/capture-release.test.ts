import test from "node:test";
import assert from "node:assert/strict";
import { captureReleaseStatus } from "../scripts/check-capture-release.ts";
const manifest = { name: "@replayio/self-healing-capture", version: "0.1.0" };
const reply = (status: number, data: unknown = {}) =>
  (async () => new Response(JSON.stringify(data), { status })) as typeof fetch;

test("release publishes absent versions and skips existing versions", async () => {
  assert.deepEqual(await captureReleaseStatus(manifest, reply(404)), {
    version: "0.1.0",
    publish: true,
  });
  assert.deepEqual(await captureReleaseStatus(manifest, reply(200, manifest)), {
    version: "0.1.0",
    publish: false,
  });
});
test("registry authentication and service errors never become publish attempts", async () => {
  for (const status of [401, 403, 429, 500])
    await assert.rejects(
      captureReleaseStatus(manifest, reply(status)),
      /lookup failed/,
    );
  await assert.rejects(
    captureReleaseStatus(
      manifest,
      reply(200, { ...manifest, version: "9.0.0" }),
    ),
    /unexpected/,
  );
});
test("release rejects the wrong package or unsafe version before contacting npm", async () => {
  const request = (async () => {
    throw new Error("must not contact npm");
  }) as typeof fetch;
  await assert.rejects(
    captureReleaseStatus({ ...manifest, name: "other" }, request),
    /Expected/,
  );
  await assert.rejects(
    captureReleaseStatus(
      { ...manifest, version: "0.1.0\npublish=true" },
      request,
    ),
    /Expected/,
  );
});
