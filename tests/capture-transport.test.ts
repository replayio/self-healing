import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeCaptureBody,
  splitBatches,
  uploadBatchBytes,
  DEFAULT_MAX_NETWORK_CAPTURE_BYTES,
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
    assert.ok(Buffer.byteLength(batch) <= uploadBatchBytes(input.session_url));
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
            {
              id: "b",
              response_body: "x".repeat(DEFAULT_MAX_NETWORK_CAPTURE_BYTES),
            },
          ],
        },
      },
    ],
  };
  assert.throws(() => splitBatches(input), /event exceeds/);
  assert.equal(
    input.auxiliary_data[0]!.payload.exchanges[1]!.response_body.length,
    DEFAULT_MAX_NETWORK_CAPTURE_BYTES,
  );
});

test("body decoding preserves UTF-8 text and rejects binary and NULs", () => {
  const text = ' café 🦊 \n {"value":"\\u0000"}';
  assert.equal(decodeCaptureBody(new TextEncoder().encode(text).buffer), text);
  assert.equal(decodeCaptureBody(new ArrayBuffer(0)), "");
  assert.equal(decodeCaptureBody(new Uint8Array([97, 0, 98]).buffer), null);
  assert.equal(decodeCaptureBody(new Uint8Array([0xff, 0xfe]).buffer), null);
});

test("batching accommodates a full-size exchange and counts encoded envelope bytes", () => {
  assert.equal(DEFAULT_MAX_NETWORK_CAPTURE_BYTES, 1_000_000);
  const entry = { id: "boundary", response_body: "" };
  const overhead = Buffer.byteLength(JSON.stringify(entry));
  entry.response_body = "x".repeat(
    DEFAULT_MAX_NETWORK_CAPTURE_BYTES - overhead,
  );
  const input = {
    session_url: "https://app.fullstory.com/session/test",
    auxiliary_data: [
      {
        namespace: "network",
        key: "captured-exchanges",
        schema_version: 1,
        payload: { version: 1, exchanges: [entry] },
      },
    ],
  };
  const batch = splitBatches(input)[0]!;
  assert.equal(Buffer.byteLength(batch), uploadBatchBytes(input.session_url));
  assert.deepEqual(JSON.parse(batch).auxiliary_data[0].payload.exchanges, [
    entry,
  ]);
  entry.response_body += "x";
  assert.throws(() => splitBatches(input), /event exceeds/);
  entry.response_body = "\u0000".repeat(180_000);
  assert.throws(() => splitBatches(input), /event exceeds/);
});
