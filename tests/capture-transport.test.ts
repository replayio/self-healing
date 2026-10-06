import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeCaptureBody,
  splitBatches,
  MAX_BATCH_BYTES,
  type Artifact,
} from "../packages/capture/src/transport.ts";

test("capture batching preserves whole Unicode events, provenance and order within the API byte limit", () => {
  const exchanges = Array.from({ length: 12 }, (_, i) => ({
    id: String(i),
    response_body: "🦊".repeat(50_000),
  }));
  const input = {
    session_url: "https://app.fullstory.com/session/test",
    auxiliary_data: [
      {
        namespace: "session",
        key: "capture-producer",
        schema_version: 1,
        payload: { name: "@replayio/self-healing-capture", version: "0.1.0" },
      },
      {
        namespace: "network",
        key: "captured-exchanges",
        schema_version: 1,
        payload: { version: 1, exchanges },
      },
      {
        namespace: "session",
        key: "identity",
        schema_version: 1,
        payload: { version: 1, email: "a@example.test" },
      },
    ],
  };
  const batches = splitBatches(input);
  assert.ok(batches.length > 1);
  assert.deepEqual(batches, splitBatches(input));
  for (const batch of batches)
    assert.ok(Buffer.byteLength(batch) <= MAX_BATCH_BYTES);
  const artifacts = batches.flatMap(
    (b) => JSON.parse(b).auxiliary_data,
  ) as Artifact[];
  assert.deepEqual(
    artifacts
      .filter((a) => a.namespace === "network")
      .flatMap((a) => a.payload.exchanges),
    exchanges,
  );
  assert.deepEqual(
    artifacts.find((a) => a.key === "capture-producer"),
    input.auxiliary_data[0],
  );
  assert.deepEqual(
    artifacts.find((a) => a.key === "identity"),
    input.auxiliary_data[2],
  );
});

test("oversized individual events fail explicitly without changing data or returning partial batches", () => {
  const input = {
    session_url: "https://app.fullstory.com/session/test",
    auxiliary_data: [
      {
        namespace: "network",
        key: "captured-exchanges",
        schema_version: 1,
        payload: {
          version: 1,
          exchanges: [
            { id: "a", response_body: "x" },
            { id: "b", response_body: "x".repeat(MAX_BATCH_BYTES) },
          ],
        },
      },
    ],
  };
  assert.throws(() => splitBatches(input), /event exceeds/);
  assert.equal(
    input.auxiliary_data[0]!.payload.exchanges[1]!.response_body.length,
    MAX_BATCH_BYTES,
  );
});

test("body decoding preserves UTF-8 text and rejects binary and NULs", () => {
  const text = ' café 🦊 \n {"value":"\\u0000"}';
  assert.equal(decodeCaptureBody(new TextEncoder().encode(text).buffer), text);
  assert.equal(decodeCaptureBody(new ArrayBuffer(0)), "");
  assert.equal(decodeCaptureBody(new Uint8Array([97, 0, 98]).buffer), null);
  assert.equal(decodeCaptureBody(new Uint8Array([0xff, 0xfe]).buffer), null);
});

test("the single default limit covers the complete encoded request including envelope and escaping", () => {
  assert.equal(MAX_BATCH_BYTES, 1_000_000);
  const input = {
    session_url: "https://app.fullstory.com/session/test",
    auxiliary_data: [
      {
        namespace: "network",
        key: "captured-exchanges",
        schema_version: 1,
        payload: {
          version: 1,
          exchanges: [{ id: "boundary", response_body: "" }],
        },
      },
    ],
  };
  const entry = input.auxiliary_data[0]!.payload.exchanges[0]!;
  const overhead = Buffer.byteLength(JSON.stringify(input));
  entry.response_body = "x".repeat(MAX_BATCH_BYTES - overhead);
  assert.equal(Buffer.byteLength(splitBatches(input)[0]!), MAX_BATCH_BYTES);
  entry.response_body += "x";
  assert.throws(() => splitBatches(input), /event exceeds/);
  entry.response_body = "\u0000".repeat(180_000);
  assert.throws(
    () => splitBatches(input),
    /event exceeds/,
    "JSON escaping counts toward the batch limit",
  );
  entry.response_body = "x".repeat(500_000);
  assert.equal(
    splitBatches(input).length,
    1,
    "bodies above the old 256 KiB cap are preserved",
  );
  assert.equal(
    JSON.parse(splitBatches(input)[0]!).auxiliary_data[0].payload.exchanges[0]
      .response_body,
    entry.response_body,
  );
});
