import test from "node:test";
import assert from "node:assert/strict";
import {
  captureReleaseStatus,
  waitForCaptureVisibility,
} from "../scripts/check-capture-release.ts";
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

test("accepted publication waits through propagation and registry read failures", async () => {
  let calls = 0;
  let pauses = 0;
  const request = (async () => {
    calls++;
    if (calls === 1) throw new Error("temporary registry outage");
    if (calls === 2) return new Response("", { status: 404 });
    return new Response(JSON.stringify(manifest));
  }) as typeof fetch;
  assert.equal(
    await waitForCaptureVisibility(manifest, request, async () => {
      pauses++;
    }),
    "visible",
  );
  assert.equal(calls, 3);
  assert.equal(pauses, 2);
});

test("accepted publication reports pending instead of failing when npm is still processing", async () => {
  for (const status of [404, 503]) {
    let pauses = 0;
    assert.equal(
      await waitForCaptureVisibility(manifest, reply(status), async () => {
        pauses++;
      }),
      "pending",
    );
    assert.equal(pauses, 5);
  }
});
