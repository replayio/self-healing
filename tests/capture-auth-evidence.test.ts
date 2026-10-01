import assert from "node:assert/strict";
import { test } from "node:test";
import { createStorageObserver } from "../packages/capture/src/auth-evidence.ts";
import { splitBatches } from "../packages/capture/src/transport.ts";

test("storage evidence never reads storage values or exports raw keys/cookie values", () => {
  let names = ["auth-SECRET-user@example.test", "preference"];
  const storage = {
    get length() {
      return names.length;
    },
    key: (i: number) => names[i] ?? null,
    getItem() {
      throw new Error("must not read values");
    },
  };
  const browser = {
    localStorage: storage,
    sessionStorage: storage,
    document: { cookie: "PRIVATE_COOKIE=SECRET_TOKEN" },
  } as unknown as Window;
  const observe = createStorageObserver([
    { area: "localStorage", key: names[0]!, alias: "auth-session" },
  ]);
  const first = observe(browser);
  assert.equal(first.areas[0]?.entries[0]?.alias, "auth-session");
  const serialized = JSON.stringify(first);
  for (const secret of [
    "SECRET",
    "PRIVATE_COOKIE",
    "preference",
    "user@example.test",
  ])
    assert.ok(!serialized.includes(secret));
  names = ["preference"];
  const second = observe(browser);
  assert.equal(
    second.areas[0]?.entries[0]?.slot,
    first.areas[0]?.entries[1]?.slot,
  );
  assert.equal(second.areas[0]?.entries.length, 1);
  assert.equal(second.http_only_cookies, "unobservable");
});

test("unobservable storage is distinct from empty storage and large inventories are bounded", () => {
  const browser = {
    get localStorage() {
      throw new Error("denied");
    },
    sessionStorage: { length: 0 },
    document: { cookie: "" },
  } as unknown as Window;
  const result = createStorageObserver()(browser);
  assert.equal(result.areas[0]?.observable, false);
  assert.equal(result.areas[1]?.observable, true);
  const large = {
    localStorage: { length: 10000, key: (i: number) => String(i) },
    sessionStorage: { length: 0 },
    document: { cookie: "" },
  } as unknown as Window;
  const snapshot = createStorageObserver()(large);
  assert.equal(snapshot.areas[0]?.entries.length, 32);
  assert.equal(snapshot.areas[0]?.truncated, true);
  assert.doesNotThrow(() =>
    splitBatches({
      session_url: "https://app.fullstory.com/session/test",
      auxiliary_data: [
        {
          namespace: "session",
          key: "auth-state-test",
          schema_version: 1,
          payload: { observations: Array(16).fill(snapshot) },
        },
      ],
    }),
  );
});
