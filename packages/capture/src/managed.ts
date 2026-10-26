import { z } from "zod";
import { createFullstoryProxyTransport } from "./recorder-transport.js";

const ManagedOptionsSchema = z.object({
  publishableKey: z.string().regex(/^lqc_[A-Za-z0-9_-]{43}$/),
  serviceUrl: z.string().url().default("https://qa.replay.io").refine(value => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      url.pathname === "/" && !url.search && !url.hash;
  }, "serviceUrl must be an HTTPS origin"),
});
const SessionUrlSchema = z.string().url().transform((value, ctx) => {
  const url = new URL(value);
  const match = /^\/ui\/replay\/(session|client-session)\/([^/]+)$/.exec(url.pathname);
  const id = match ? decodeURIComponent(match[2]!) : "";
  if (url.origin !== "https://qa.replay.io" || url.search || url.hash || !match ||
      id.length > 512 || !/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid recorder session" });
    return z.NEVER;
  }
  return { id, kind: match[1] as "session" | "client-session" };
});
const BatchSchema = z.object({
  session_url: SessionUrlSchema,
  auxiliary_data: z.array(z.object({
    namespace: z.string(), key: z.string(), schema_version: z.number(), payload: z.unknown(),
  })),
});

export function managedCapture(options: { publishableKey: string; serviceUrl?: string }, send: typeof fetch) {
  const config = ManagedOptionsSchema.parse(options);
  const origin = new URL(config.serviceUrl).origin;
  const captureEndpoint = `${origin}/api/fullstory-capture`;
  const endpoint = new URL(`${origin}/api/monitoring-register`);
  const transport = createFullstoryProxyTransport(captureEndpoint, config.publishableKey, send);
  return {
    endpoint,
    transport,
    recorderOptions: {
      orgId: "replay",
      host: `${endpoint.host}/api/fullstory-capture`,
      script: `${endpoint.host}/fs.js`,
      // A recorder-local URL used only to identify sessions; QA builds the real FullStory URL.
      appHost: "qa.replay.io",
    },
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.publishableKey}` },
    encode(body: string) {
      const batch = BatchSchema.parse(JSON.parse(body));
      return JSON.stringify({ session: batch.session_url, auxiliary_data: batch.auxiliary_data });
    },
    async register(sessionUrl: string) {
      const response = await send(endpoint.href, {
        method: "POST", headers: this.headers, credentials: "omit", redirect: "error",
        body: JSON.stringify({ session: SessionUrlSchema.parse(sessionUrl) }),
      });
      if (!response.ok) throw new Error(`Capture registration failed: ${response.status}`);
    },
    isTransport(url: string) {
      const target = new URL(url);
      return target.origin === origin && (target.pathname === "/api/monitoring-register" ||
        target.pathname.startsWith("/api/fullstory-capture/") || target.pathname === "/fs.js");
    },
  };
}
