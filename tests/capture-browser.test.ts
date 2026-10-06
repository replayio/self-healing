import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";
import { operations } from "../src/api/contracts.ts";
import * as transport from "../packages/capture/src/transport.ts";
const NetworkAuxiliaryPayloadSchema = z.object({
  exchanges: z.array(
    z
      .object({ id: z.string(), url: z.string(), captured_at: z.number() })
      .passthrough(),
  ),
});
const InteractionAuxiliaryPayloadSchema = z.object({
  interactions: z.array(
    z.object({
      kind: z.string(),
      key: z.string().optional(),
      metaKey: z.boolean().optional(),
      text: z.string().optional(),
      value: z.string().optional(),
    }),
  ),
});

const UploadSchema = z.object({
  session_url: z.string(),
  auxiliary_data: z.array(
    z.object({ namespace: z.string(), key: z.string(), payload: z.unknown() }),
  ),
});

for (const maxNetworkCaptureBytes of [undefined, 300_000]) {
  test(`package captures startup, rollover, in-flight responses, inputs and retries (limit ${maxNetworkCaptureBytes ?? "default"})`, async () => {
    const uploads: string[] = [];
    let failNext = false;
    let sessionUrl = "https://app.fullstory.com/session/test";
    let rejectedBatchStatus = 0;
    let responseBody: BodyInit = '{"user":null}';
    let terminalFailure = false;
    let releaseSlow: (() => void) | undefined;
    const callbacks: {
      ready?: (value: { sessionUrl: string }) => Promise<void>;
    } = {};
    const timers = new Map<number, () => void>();
    let timerId = 0;
    const listeners = new Map<string, (event: unknown) => void>();
    class FakeElement {
      tagName = "TEXTAREA";
      textContent = "";
      value = "";
      getAttribute(name: string) {
        return name === "data-testid" ? "start-bar" : null;
      }
      matches() {
        return true;
      }
    }
    class FakeKeyboardEvent {}
    class FakeInputEvent {}
    class FakeClipboardEvent {}
    const fakeWindow = {
      location: {
        href: "https://example.test/",
        origin: "https://example.test",
      },
      removeEventListener(name: string) {
        listeners.delete(name);
      },
      async fetch(
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> {
        const url = input instanceof Request ? input.url : String(input);
        if (url === "https://example.test/api/self-healing/session") {
          uploads.push(String(init?.body));
          if (
            rejectedBatchStatus &&
            String(init?.body).includes("/rejected-batch")
          )
            return new Response("", { status: rejectedBatchStatus });
          if (terminalFailure) return new Response("", { status: 409 });
          if (failNext) {
            failNext = false;
            return new Response("", { status: 503 });
          }
          return new Response("", { status: 202 });
        }
        if (url.endsWith("/slow"))
          await new Promise<void>((resolve) => {
            releaseSlow = resolve;
          });
        return new Response(responseBody, {
          headers: { "Content-Type": "application/json" },
        });
      },
      addEventListener(name: string, callback: (event: unknown) => void) {
        listeners.set(name, callback);
      },
    };
    const sdk = {
      FullStory(method: string) {
        return method === "getSession" ? sessionUrl : undefined;
      },
      init(_options: unknown, ready: NonNullable<typeof callbacks.ready>) {
        callbacks.ready = ready;
      },
    };
    const exports: {
      initCapture?: (options: {
        orgId: string;
        maxNetworkCaptureBytes?: number;
        onError?: (error: Error) => void;
      }) => {
        identify: (user: { id: string; name: string; email: string }) => void;
        flush(): Promise<void>;
        stop(): Promise<void>;
      };
    } = {};
    const source = readFileSync(
      new URL("../packages/capture/src/index.ts", import.meta.url),
      "utf8",
    );
    const output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    runInNewContext(output, {
      exports,
      require: (name: string) =>
        name === "@fullstory/browser" ? sdk : transport,
      window: fakeWindow,
      URL,
      Request,
      Response,
      TextEncoder,
      TextDecoder,
      console,
      Element: FakeElement,
      HTMLElement: FakeElement,
      HTMLInputElement: FakeElement,
      HTMLTextAreaElement: FakeElement,
      HTMLSelectElement: FakeElement,
      KeyboardEvent: FakeKeyboardEvent,
      InputEvent: FakeInputEvent,
      ClipboardEvent: FakeClipboardEvent,
      crypto: { randomUUID },
      performance: { now: () => 403, timeOrigin: 1000 },
      setTimeout(callback: () => void, delay: number) {
        if (delay !== 250) {
          queueMicrotask(callback);
          return 0;
        }
        timers.set(++timerId, callback);
        return timerId;
      },
      clearTimeout(id: number) {
        timers.delete(id);
      },
    });
    for (const invalid of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assert.throws(
        () =>
          exports.initCapture!({
            orgId: "test",
            maxNetworkCaptureBytes: invalid,
          }),
        /positive safe integer/,
      );
    }
    const capture = exports.initCapture!({
      orgId: "test",
      maxNetworkCaptureBytes,
      onError: () => {},
    });
    assert.throws(
      () =>
        exports.initCapture!({ orgId: "test", maxNetworkCaptureBytes: 1234 }),
      /different options/,
    );
    assert.equal(
      exports.initCapture!({
        orgId: "test",
        maxNetworkCaptureBytes: maxNetworkCaptureBytes ?? 1_000_000,
      }),
      capture,
      "initialization is idempotent",
    );
    assert.ok(callbacks.ready);
    const startup = fakeWindow.fetch("https://example.test/startup/slow");
    assert.ok(releaseSlow);
    await callbacks.ready({ sessionUrl });
    const initialBody = uploads[0]!;
    const manifest = JSON.parse(
      readFileSync(
        new URL("../packages/capture/package.json", import.meta.url),
        "utf8",
      ),
    );
    assert.deepEqual(
      JSON.parse(initialBody).auxiliary_data.find(
        (a: { key: string }) => a.key === "capture-producer",
      ).payload,
      { name: manifest.name, version: manifest.version },
    );
    operations
      .find((operation) => operation.id === "ingestSession")!
      .body!.parse(JSON.parse(initialBody));
    const initialRegistration = UploadSchema.parse(JSON.parse(uploads[0]!));
    releaseSlow();
    await startup;
    await capture.flush();
    await flush();
    const startupEntries = uploads
      .flatMap((body) => UploadSchema.parse(JSON.parse(body)).auxiliary_data)
      .filter((a) => a.namespace === "network")
      .flatMap((a) => NetworkAuxiliaryPayloadSchema.parse(a.payload).exchanges);
    assert.equal(
      startupEntries.filter((e) => e.url.endsWith("/startup/slow")).length,
      1,
    );
    uploads.length = 0;
    async function flush() {
      for (let i = 0; i < 20; i++) {
        for (const callback of timers.values()) callback();
        timers.clear();
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    await fakeWindow.fetch("https://example.test/api/auth-me");
    failNext = true;
    await flush();
    assert.equal(uploads.length, 2);
    assert.equal(
      uploads[0],
      uploads[1],
      "retry must reuse the exact batch and event IDs",
    );
    await fakeWindow.fetch("https://example.test/api/auth-me");
    await flush();
    assert.equal(uploads.length, 3);
    const entries = [uploads[0]!, uploads[2]!].map((body) => {
      const payload = UploadSchema.parse(JSON.parse(body)).auxiliary_data.find(
        (a) => a.namespace === "network",
      )?.payload;
      return NetworkAuxiliaryPayloadSchema.parse(payload).exchanges;
    });
    assert.equal(entries[0]?.length, 1);
    assert.equal(
      entries[1]?.length,
      1,
      "later upload must exclude the earlier exchange",
    );
    assert.notEqual(
      entries[0]?.[0]?.id,
      entries[1]?.[0]?.id,
      "identical requests are distinct events",
    );
    assert.equal(entries[0]?.[0]?.captured_at, 1403);
    const target = new FakeElement();
    const exact = "https://testflair.ai/?x=1&y=2\n  café 🦊 ";
    for (const type of ["keydown", "paste", "input", "keyup", "input"]) {
      const event = Object.assign(
        type === "paste"
          ? new FakeClipboardEvent()
          : type === "input"
            ? new FakeInputEvent()
            : new FakeKeyboardEvent(),
        {
          type,
          isTrusted: true,
          composedPath: () => [target],
          key: "v",
          code: "KeyV",
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
          repeat: false,
          isComposing: false,
          inputType: "insertFromPaste",
          clipboardData: { getData: () => exact },
        },
      );
      target.value = type === "keyup" ? "" : exact;
      if (type === "input" && uploads.length > 6) target.value = "";
      assert.ok(listeners.get(type), `${type} listener must be installed`);
      listeners.get(type)!(event);
      await flush();
    }
    const interactions = uploads.slice(3).flatMap((body) => {
      const payload = UploadSchema.parse(JSON.parse(body)).auxiliary_data.find(
        (a) => a.namespace === "interaction",
      )?.payload;
      return payload
        ? InteractionAuxiliaryPayloadSchema.parse(payload).interactions
        : [];
    });
    assert.deepEqual(
      interactions.map((e) => e.kind),
      ["keydown", "paste", "input", "keyup", "input"],
    );
    assert.equal(interactions[0]?.key, "v");
    assert.equal(interactions[0]?.metaKey, true);
    assert.equal(interactions[1]?.text, exact);
    assert.equal(interactions[2]?.value, exact);
    assert.equal(interactions[4]?.value, "");

    capture.identify({ id: "user", name: "User", email: "user@example.test" });
    await flush();
    if (process.env.CAPTURE_FIXTURE_PATH) {
      writeFileSync(
        process.env.CAPTURE_FIXTURE_PATH,
        JSON.stringify(
          {
            description:
              "Generated by @replayio/self-healing-capture 0.1.1 using tests/capture-browser.test.ts; includes a repeated batch for retry compatibility.",
            batches: [
              JSON.parse(initialBody),
              ...uploads.map((body) => JSON.parse(body)),
            ],
          },
          null,
          2,
        ) + "\n",
      );
    }
    const oldUrl = sessionUrl;
    const slow = fakeWindow.fetch("https://example.test/slow");
    assert.ok(releaseSlow);
    // No ready callback: each producer must discover the changed SDK session itself.
    sessionUrl = "https://app.fullstory.com/session/next";
    listeners.get("click")!({
      type: "click",
      isTrusted: true,
      composedPath: () => [target],
    });
    await fakeWindow.fetch("https://example.test/new-session");
    await flush();
    releaseSlow();
    await slow;
    await flush();
    const parsed = uploads.map((body) => UploadSchema.parse(JSON.parse(body)));
    const late = parsed.find((batch) =>
      batch.auxiliary_data.some(
        (a) =>
          a.namespace === "network" &&
          NetworkAuxiliaryPayloadSchema.parse(a.payload).exchanges.some((e) =>
            e.url.endsWith("/slow"),
          ),
      ),
    );
    assert.equal(
      late?.session_url,
      oldUrl,
      "in-flight response belongs to its request-start session",
    );
    const fresh = parsed.filter((batch) => batch.session_url === sessionUrl);
    const freshArtifacts = fresh.flatMap((batch) => batch.auxiliary_data);
    assert.deepEqual(freshArtifacts.find((a) => a.key === "metrics")?.payload, {
      version: 1,
      interaction_count: 1,
    });
    assert.deepEqual(
      freshArtifacts.find((a) => a.key === "identity")?.payload,
      { version: 1, email: "user@example.test" },
    );
    assert.equal(
      InteractionAuxiliaryPayloadSchema.parse(
        freshArtifacts.find((a) => a.namespace === "interaction")?.payload,
      ).interactions.length,
      1,
    );
    const ContextSchema = z.object({
      pages: z.array(
        z.object({
          id: z.string(),
          previous_session_url: z.string().nullable(),
          dropped_network_count: z.number(),
          dropped_interaction_count: z.number(),
        }),
      ),
    });
    const initialContext = ContextSchema.parse(
      initialRegistration.auxiliary_data.find(
        (a) => a.key === "capture-context",
      )?.payload,
    );
    const nextContext = ContextSchema.parse(
      freshArtifacts.find((a) => a.key === "capture-context")?.payload,
    );
    assert.equal(nextContext.pages[0]?.previous_session_url, oldUrl);
    assert.equal(
      nextContext.pages[0]?.id,
      initialContext.pages[0]?.id,
      "page identity persists across sessions",
    );

    // A gzip-like body labelled as text must not poison JSONB ingestion.
    const binary = new Uint8Array([31, 139, 8, 0, 0, 0, 0, 0, 0, 3, 255]);
    responseBody = binary;
    await fakeWindow.fetch("https://example.test/binary", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: binary,
    });
    await capture.flush();
    const binaryExchange = uploads
      .flatMap((body) => UploadSchema.parse(JSON.parse(body)).auxiliary_data)
      .filter((a) => a.namespace === "network")
      .flatMap((a) => NetworkAuxiliaryPayloadSchema.parse(a.payload).exchanges)
      .find((e) => e.url.endsWith("/binary"));
    assert.equal(binaryExchange?.request_body, null);
    assert.equal(binaryExchange?.response_body, null);
    responseBody = '{"ok":true}';

    // Neither a persistent 500 nor a rejected 400 can suppress later text events.
    for (const status of [500, 400]) {
      rejectedBatchStatus = status;
      await fakeWindow.fetch("https://example.test/rejected-batch");
      await assert.rejects(
        capture.flush(),
        new RegExp(`Capture upload failed: ${status}`),
      );
      const rejected = uploads.at(-1)!;
      const before = uploads.length;
      target.value = `after failure ${status}`;
      listeners.get("input")!({
        type: "input",
        isTrusted: true,
        composedPath: () => [target],
      });
      await assert.rejects(capture.flush(), /Capture upload failed/);
      const later = uploads.slice(before);
      assert.ok(
        later.includes(rejected),
        "failed batch is retried with identical IDs",
      );
      assert.ok(
        later.some((body) => body.includes(target.value)),
        "later interaction is uploaded even while an earlier batch fails",
      );
      rejectedBatchStatus = 0;
      await capture.flush();
      const afterRecovery: number = uploads.length;
      await capture.flush();
      assert.equal(
        uploads.length,
        afterRecovery,
        "successful batches are no longer pending",
      );
    }

    const beforeOversized = uploads.length;
    responseBody = "x".repeat(maxNetworkCaptureBytes ?? 1_000_000);
    await fakeWindow.fetch("https://example.test/oversized-exchange");
    await capture.flush();
    responseBody = "small";
    await fakeWindow.fetch("https://example.test/after-oversized");
    await capture.flush();
    const afterOversized = uploads
      .slice(beforeOversized)
      .flatMap((b) => JSON.parse(b).auxiliary_data);
    const networkAfter = afterOversized
      .filter((a) => a.namespace === "network")
      .flatMap((a) => a.payload.exchanges);
    assert.ok(!networkAfter.some((e) => e.url.endsWith("/oversized-exchange")));
    assert.ok(networkAfter.some((e) => e.url.endsWith("/after-oversized")));
    assert.ok(
      afterOversized.some(
        (a) =>
          a.key === "capture-context" &&
          a.payload.pages[0].dropped_network_count > 0,
      ),
    );

    responseBody = "x".repeat(200_000);
    for (let i = 0; i < 42; i++) {
      await fakeWindow.fetch(`https://example.test/budget/${i}`);
      await flush();
    }
    const capped = uploads
      .map((b) => UploadSchema.parse(JSON.parse(b)))
      .filter((b) => b.session_url === sessionUrl)
      .flatMap((b) => b.auxiliary_data)
      .filter((a) => a.key === "capture-context")
      .at(-1);
    assert.ok(
      ContextSchema.parse(capped?.payload).pages[0]!.dropped_network_count > 0,
    );
    for (let i = 0; i < 5_001; i++)
      listeners.get("click")!({
        type: "click",
        isTrusted: true,
        composedPath: () => [target],
      });
    await flush();
    const interactionCap = uploads
      .map((b) => UploadSchema.parse(JSON.parse(b)))
      .filter((b) => b.session_url === sessionUrl)
      .flatMap((b) => b.auxiliary_data)
      .filter((a) => a.key === "capture-context")
      .at(-1);
    assert.ok(
      ContextSchema.parse(interactionCap?.payload).pages[0]!
        .dropped_interaction_count > 0,
    );
    // A terminal error on this session must not stop any producer on its successor.
    terminalFailure = true;
    listeners.get("click")!({
      type: "click",
      isTrusted: true,
      composedPath: () => [target],
    });
    await flush();
    terminalFailure = false;
    sessionUrl = "https://app.fullstory.com/session/after-failure";
    await callbacks.ready({ sessionUrl });
    await fakeWindow.fetch("https://example.test/fresh-budget");
    listeners.get("click")!({
      type: "click",
      isTrusted: true,
      composedPath: () => [target],
    });
    await flush();
    const recovered = uploads
      .map((b) => UploadSchema.parse(JSON.parse(b)))
      .filter((b) => b.session_url === sessionUrl)
      .flatMap((b) => b.auxiliary_data);
    assert.ok(
      recovered.some(
        (a) =>
          a.namespace === "network" &&
          NetworkAuxiliaryPayloadSchema.parse(a.payload).exchanges.some((e) =>
            e.url.endsWith("/fresh-budget"),
          ),
      ),
    );
    assert.ok(recovered.some((a) => a.namespace === "interaction"));
    assert.deepEqual(recovered.find((a) => a.key === "identity")?.payload, {
      version: 1,
      email: "user@example.test",
    });
    assert.deepEqual(
      recovered.filter((a) => a.key === "metrics").at(-1)?.payload,
      { version: 1, interaction_count: 1 },
    );
    await capture.flush();
    const uploadCount = uploads.length;
    sessionUrl = "";
    await fakeWindow.fetch("https://example.test/capture-stopped");
    listeners.get("click")!({
      type: "click",
      isTrusted: true,
      composedPath: () => [target],
    });
    await flush();
    assert.equal(
      uploads.length,
      uploadCount,
      "unavailable SDK session must not capture into the previous session",
    );
    await capture.stop();
    assert.equal(listeners.size, 0);
    await callbacks.ready({
      sessionUrl: "https://app.fullstory.com/session/after-stop",
    });
    await fakeWindow.fetch("https://example.test/after-stop");
    await flush();
    assert.equal(
      uploads.length,
      uploadCount,
      "stop must not register later SDK sessions",
    );
    for (const body of uploads)
      assert.ok(
        Buffer.byteLength(body) <=
          transport.uploadBatchBytes(
            JSON.parse(body).session_url,
            maxNetworkCaptureBytes,
          ),
        "all upload paths honor the derived batch budget",
      );
  });
}
