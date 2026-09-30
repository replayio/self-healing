import test from "node:test";
import assert from "node:assert/strict";
import { createScreenshotQueue } from "../src/dashboard/screenshot-queue.ts";

test("visible screenshots are serialized; canceled rows are skipped and failures release the queue", async () => {
  const enqueue = createScreenshotQueue();
  const signal = new AbortController().signal;
  const canceled = new AbortController();
  const calls: number[] = [];
  let release!: () => void;
  const first = enqueue(async () => {
    calls.push(1);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    throw new Error("provider failed");
  }, signal);
  const skipped = enqueue(async () => {
    calls.push(2);
  }, canceled.signal);
  const last = enqueue(async () => {
    calls.push(3);
    return "image";
  }, signal);
  const failed = assert.rejects(first, /provider failed/);
  const aborted = assert.rejects(skipped, { name: "AbortError" });
  await Promise.resolve();
  assert.deepEqual(calls, [1]);
  canceled.abort();
  release();
  await Promise.all([failed, aborted]);
  assert.equal(await last, "image");
  assert.deepEqual(calls, [1, 3]);
});
