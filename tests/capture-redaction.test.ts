import assert from "node:assert/strict";
import { test } from "node:test";
import { redactExchange } from "../packages/capture/src/redaction.ts";

const exchange = (response: string, request: string | null = null) => ({
  id: "test",
  url: "https://example.test/api",
  method: "POST",
  status: 200,
  captured_at: 100,
  source_timestamp: 10,
  request_headers: { "content-type": "application/json" },
  request_body: request,
  response_headers: { "content-type": "application/json" },
  response_body: response,
});
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

test("small exchanges preserve exact request and response bytes", () => {
  const original = exchange('{ "ok": true }', '{"b":2, "a":1}');
  assert.deepEqual(redactExchange(original, 1024), original);
});
test("JSON replaces largest text first while preserving identifiers and small values", () => {
  const original = exchange(
    JSON.stringify({
      id: "record-1",
      small: "keep",
      large: "😀".repeat(4000),
      count: 3,
    }),
  );
  const reduced = redactExchange(original, 1024);
  assert.ok(size(reduced) <= 1024);
  assert.deepEqual(JSON.parse(reduced.response_body!), {
    id: "record-1",
    small: "keep",
    large: "[qa_redacted]",
    count: 3,
  });
  assert.equal(reduced.redacted?.response_body, true);
  assert.ok(
    JSON.parse(original.response_body).large === "😀".repeat(4000),
    "input is not mutated",
  );
});
test("structural JSON overhead can redact subtrees after text leaves", () => {
  const original = exchange(
    JSON.stringify({
      id: "keep",
      rows: Array.from({ length: 1000 }, (_, i) => ({ id: i, text: "x" })),
    }),
  );
  const reduced = redactExchange(original, 1024);
  assert.ok(size(reduced) <= 1024);
  assert.deepEqual(JSON.parse(reduced.response_body!), {
    id: "keep",
    rows: "[qa_redacted]",
  });
});
test("text truncation accounts for Unicode and nested JSON escaping", () => {
  const reduced = redactExchange(exchange('😀\n"\\'.repeat(4000)), 1024);
  assert.ok(size(reduced) <= 1024);
  assert.ok(reduced.response_body!.endsWith("[qa_redacted]"));
  assert.ok(reduced.response_body!.startsWith('😀\n"\\'));
  assert.ok(!reduced.response_body!.includes("\ufffd"));
});
test("both request and response payloads are bounded and marked", () => {
  const reduced = redactExchange(
    exchange(
      JSON.stringify({ body: "x".repeat(5000) }),
      JSON.stringify({ body: "y".repeat(5000) }),
    ),
    1024,
  );
  assert.ok(size(reduced) <= 1024);
  assert.equal(reduced.redacted?.request_body, true);
  assert.equal(reduced.redacted?.response_body, true);
  assert.equal(JSON.parse(reduced.request_body!).body, "[qa_redacted]");
});
test("large headers and URL still retain a bounded exchange with degraded metadata marked", () => {
  const original = {
    ...exchange("ok"),
    url: "https://example.test/" + "x".repeat(4000),
    request_headers: { large: "x".repeat(5000) },
  };
  const reduced = redactExchange(original, 1024);
  assert.ok(size(reduced) <= 1024);
  assert.equal(reduced.redacted?.metadata, true);
  assert.equal(new URL(reduced.url).hostname, "example.test");
});
test("wide and deep JSON remains valid within the serialized limit", () => {
  for (const value of [
    Object.fromEntries(
      Array.from({ length: 2000 }, (_, i) => ["property-" + i, "a"]),
    ),
    Array.from({ length: 10000 }, (_, i) => i),
    { a: { b: { c: "x".repeat(10000) } }, d: "keep" },
    { __proto__: null, constructor: { value: "x".repeat(10000) } },
  ]) {
    const reduced = redactExchange(exchange(JSON.stringify(value)), 1024);
    assert.ok(size(reduced) <= 1024);
    assert.doesNotThrow(() => JSON.parse(reduced.response_body!));
  }
});

test("bounded exchanges across body ratios, escaping, and configurable limits", () => {
  for (const limit of [1024, 2048, 3000]) {
    for (let count = 1; count <= 20; count++) {
      const original = exchange(
        JSON.stringify({
          id: "keep",
          nested: Array.from({ length: count }, () => ({
            text: '😀\\\n"'.repeat(count * 20),
          })),
        }),
        JSON.stringify({ text: "x".repeat((21 - count) * 500) }),
      );
      const reduced = redactExchange(original, limit);
      assert.ok(size(reduced) <= limit);
      assert.doesNotThrow(() => JSON.parse(reduced.request_body!));
      assert.doesNotThrow(() => JSON.parse(reduced.response_body!));
    }
  }
});
