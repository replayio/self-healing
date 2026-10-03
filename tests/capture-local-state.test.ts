import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captureValue,
  createStorageObserver,
  watchStorageWrites,
} from "../packages/capture/src/local-state.ts";
import { readIndexedState } from "../packages/capture/src/indexed-state.ts";
import { LocalStatePayload } from "../src/api/contracts.ts";

test("nested JSON and serialized stores retain general structure without scalar secrets", () => {
  const value = captureValue(
    JSON.stringify({
      preferences: JSON.stringify({ darkMode: true }),
      user: { token: "secret-token", email: "private@example.test", id: 12345 },
      cache: [null, false],
    }),
  );
  const text = JSON.stringify(value);
  for (const secret of ["secret-token", "private@example.test", "12345"])
    assert.ok(!text.includes(secret));
  for (const field of ["preferences", "darkMode", "user", "token", "cache"])
    assert.ok(text.includes(field));
  assert.ok(text.includes('"value":true'));
  assert.ok(text.includes('"type":"null"'));
  const cyc: Record<string, unknown> = {};
  cyc.self = cyc;
  assert.ok(JSON.stringify(captureValue(cyc)).includes("truncated"));
});

test("blocked storage differs from empty storage and cookie values never enter evidence", () => {
  const browser = {
    get localStorage() {
      throw new Error("denied");
    },
    sessionStorage: { length: 0 },
    document: { cookie: "session=SECRET" },
  } as unknown as Window;
  const data = createStorageObserver()(browser);
  assert.equal(data.areas[0]?.observable, false);
  assert.equal(data.areas[1]?.observable, true);
  assert.ok(!JSON.stringify(data).includes("SECRET"));
  assert.equal(data.http_only_cookies, "unobservable");
});

test("write instrumentation preserves returns, errors, and restores methods on stop", () => {
  class Store {
    setItem(key: string) {
      if (key === "fail") throw new Error("quota");
      return 7;
    }
    removeItem() {}
    clear() {}
  }
  const store = new Store();
  const original = Store.prototype.setItem;
  let calls = 0;
  const stop = watchStorageWrites(
    { localStorage: store } as unknown as Window,
    () => {
      calls++;
    },
  );
  assert.equal(store.setItem("x"), 7);
  assert.equal(calls, 1);
  assert.throws(() => store.setItem("fail"), /quota/);
  assert.equal(calls, 1);
  stop();
  assert.equal(Store.prototype.setItem, original);
});

test("unavailable IndexedDB is explicitly recorded and API rejects raw scalar values", async () => {
  const area = await readIndexedState({} as Window);
  assert.equal(area.observable, false);
  const payload = {
    version: 1,
    page_id: "00000000-0000-4000-8000-000000000000",
    page_started_at: 1,
    dropped_observation_count: 0,
    observations: [
      {
        captured_at: 2,
        source_timestamp: 1,
        reason: "indexedDB",
        storage: { areas: [area], http_only_cookies: "unobservable" },
      },
    ],
  };
  assert.equal(LocalStatePayload.safeParse(payload).success, true);
  area.entries.push({
    slot: "slot-0",
    name: "store",
    value: { type: "string", redacted: true, value: "SECRET" } as never,
  });
  assert.equal(LocalStatePayload.safeParse(payload).success, false);
});

test("IndexedDB captures nested records read-only, redacts values and closes connections", async () => {
  let closed = 0;
  let readonly = false;
  const records = [
    { user: { token: "SECRET", active: true }, settings: { compact: false } },
  ];
  const db = {
    name: "appStore",
    objectStoreNames: ["state"],
    close() {
      closed++;
    },
    transaction(_names: string[], mode: string) {
      readonly = mode === "readonly";
      const tx = {
        oncomplete: null as null | (() => void),
        onabort: null as null | (() => void),
        onerror: null as null | (() => void),
        abort() {},
        objectStore() {
          return {
            openCursor() {
              let index = 0;
              const request = {
                result: null as unknown,
                onsuccess: null as null | (() => void),
                onerror: null,
              };
              const step = () =>
                queueMicrotask(() => {
                  request.result =
                    index < records.length
                      ? {
                          value: records[index],
                          continue() {
                            index++;
                            step();
                          },
                        }
                      : null;
                  request.onsuccess?.();
                  if (index >= records.length)
                    queueMicrotask(() => tx.oncomplete?.());
                });
              step();
              return request;
            },
          };
        },
      };
      return tx;
    },
  };
  const browser = {
    indexedDB: {
      async databases() {
        return [{ name: "appStore" }];
      },
      open() {
        const request = {
          result: db,
          onsuccess: null as null | (() => void),
          onerror: null,
          onblocked: null,
          onupgradeneeded: null,
        };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    },
  } as unknown as Window;
  const result = await readIndexedState(browser);
  assert.equal(readonly, true);
  assert.ok(closed > 0);
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.entries[0]?.path, ["appStore", "state"]);
  assert.ok(JSON.stringify(result).includes("active"));
  assert.ok(!JSON.stringify(result).includes("SECRET"));
});

test("large local-state snapshots remain inside the transport budget", () => {
  const large = JSON.stringify(
    Object.fromEntries(
      Array.from({ length: 32 }, (_, i) => [
        "field" + i,
        Array(16).fill({ nested: "SECRET" }),
      ]),
    ),
  );
  const storage = {
    length: 32,
    key: (i: number) => "entry" + i,
    getItem: () => large,
  };
  const browser = {
    localStorage: storage,
    sessionStorage: storage,
    document: { cookie: "" },
  } as unknown as Window;
  const state = createStorageObserver()(browser);
  assert.ok(state.areas.some((area) => area.truncated));
  assert.ok(
    Buffer.byteLength(JSON.stringify(Array(16).fill(state))) < 256 * 1024,
  );
});
