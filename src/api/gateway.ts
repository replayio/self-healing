import { randomUUID } from "node:crypto";
import { z } from "zod";
import { GatewayRpc, GatewayCall } from "./contracts.ts";
import { HttpError } from "./errors.ts";
import type { Query } from "./store.ts";
import type { credentialVault } from "./credentials.ts";
import { normalizeSessionUrl } from "./sessions.ts";

const Context = z.object({
  id: z.string().uuid(),
  encrypted_upstream_id: z.string().nullable(),
  client_ids: z.array(z.string()),
});
const Envelope = z
  .object({ result: z.unknown().optional(), error: z.unknown().optional() })
  .passthrough();
const Content = z
  .object({
    content: z
      .array(z.object({ text: z.string().optional() }).passthrough())
      .default([]),
  })
  .passthrough();
const Tools = z
  .object({ tools: z.array(z.object({ name: z.string() }).passthrough()) })
  .passthrough();
const allowed = new Set([
  "review-open",
  "review-zoom",
  "review-snapshot",
  "review-close",
]);
// Error bodies may echo provider credentials. Only expose a bounded JSON error message.
async function upstreamDiagnostic(response: Response, secrets: string[]) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) return "";
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    let message = body?.error?.message ?? body?.message ?? body?.error;
    if (typeof message !== "string") return "";
    for (const secret of secrets.filter(Boolean)) {
      for (const value of [secret, encodeURIComponent(secret)])
        message = message.split(value).join("[redacted]");
    }
    return message.replace(/[\r\n\t]/g, " ").slice(0, 512);
  } catch {
    return "";
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function gatewayRequest(
  incoming: Request,
  key: string,
  body: unknown,
  scope: {
    sessionId: string;
    sessionUrl: string;
    query: Query;
    vault: ReturnType<typeof credentialVault>;
  },
  request: typeof fetch = fetch,
) {
  const rpc = GatewayRpc.parse(body);
  const { query, vault, sessionId } = scope;
  let context: z.infer<typeof Context>;
  if (rpc.method === "initialize") {
    context = { id: randomUUID(), encrypted_upstream_id: null, client_ids: [] };
    await query("INSERT INTO gateway_contexts(id,session_id) VALUES ($1,$2)", [
      context.id,
      sessionId,
    ]);
  } else {
    const id = z
      .string()
      .uuid()
      .safeParse(incoming.headers.get("mcp-session-id"));
    const [row] = id.success
      ? await query(
          "SELECT * FROM gateway_contexts WHERE id=$1 AND session_id=$2 AND expires_at>now()",
          [id.data, sessionId],
        )
      : [];
    if (!row)
      throw new HttpError(404, "mcp_expired", "Initialize a new MCP session.");
    context = Context.parse(row);
  }
  let tool: string | undefined;
  if (rpc.method === "tools/call") {
    const call = GatewayCall.parse(rpc.params);
    tool = call.name;
    const args = call.arguments ?? {};
    if (tool === "review-open") {
      const urls = Object.entries(args);
      if (
        !urls.length ||
        urls.some(
          ([k, v]) =>
            !["url", "session_url", "sessionUrl"].includes(k) ||
            typeof v !== "string" ||
            normalizeSessionUrl(v) !== scope.sessionUrl,
        )
      )
        throw new HttpError(
          403,
          "session_scope",
          "Callback only permits its registered session.",
        );
    } else {
      const ids = [args.client_id, args.clientId].filter(
        (v) => v !== undefined,
      );
      if (
        !ids.length ||
        ids.some((v) => typeof v !== "string") ||
        ["url", "session_url", "sessionUrl"].some((k) => k in args)
      )
        throw new HttpError(
          403,
          "session_scope",
          "Review client does not belong to this callback.",
        );
      for (const client of ids) {
        const owned = await query(
          "SELECT id FROM gateway_contexts WHERE session_id=$1 AND client_ids ? $2 LIMIT 1",
          [sessionId, client],
        );
        if (!owned.length)
          throw new HttpError(
            403,
            "session_scope",
            "Review client does not belong to this callback.",
          );
      }
    }
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (context.encrypted_upstream_id)
    headers["Mcp-Session-Id"] = vault.decrypt(
      context.encrypted_upstream_id,
      sessionId,
    );
  let response: Response;
  try {
    response = await request("https://api.fullstory.com/mcp/subtext", {
      method: "POST",
      headers,
      body: JSON.stringify(rpc),
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new HttpError(503, "subtext_unavailable", "Subtext did not respond.");
  }
  if (!response.ok) {
    const diagnostic = await upstreamDiagnostic(response, [
      key,
      headers["Mcp-Session-Id"] ?? "",
      response.headers.get("mcp-session-id") ?? "",
    ]);
    throw new HttpError(
      [400, 401, 403, 404, 429].includes(response.status)
        ? response.status
        : 503,
      "subtext_unavailable",
      `Subtext ${tool ?? rpc.method} rejected the callback request (HTTP ${response.status}).${diagnostic ? ` ${diagnostic}` : ""}`,
    );
  }
  const upstream = response.headers.get("mcp-session-id");
  if (upstream)
    await query(
      "UPDATE gateway_contexts SET encrypted_upstream_id=$2 WHERE id=$1",
      [context.id, vault.encrypt(upstream, sessionId)],
    );
  // Bound transient evidence in memory. It is never persisted to the coordination database.
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 32 * 1024 * 1024) {
          await reader.cancel();
          throw new HttpError(
            502,
            "subtext_response_large",
            "Subtext response exceeded the limit.",
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const responseHeaders = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Mcp-Session-Id": context.id,
  };
  if (!text.trim())
    return new Response(null, {
      status: response.status,
      headers: responseHeaders,
    });
  let envelope: z.infer<typeof Envelope>;
  try {
    const data = text.trim().startsWith("{")
      ? text
      : text
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .filter((l) => l && l !== "[DONE]")
          .at(-1)!;
    envelope = Envelope.parse(JSON.parse(data));
  } catch {
    throw new HttpError(
      502,
      "subtext_invalid",
      "Subtext returned an invalid MCP response.",
    );
  }
  if (envelope.error)
    return Response.json(
      {
        jsonrpc: "2.0",
        id: rpc.id,
        error: {
          code: -32000,
          message: "Subtext could not complete the request.",
        },
      },
      { headers: responseHeaders },
    );
  if (rpc.method === "tools/list") {
    const tools = Tools.parse(envelope.result);
    envelope.result = {
      ...tools,
      tools: tools.tools.filter((t) => allowed.has(t.name)),
    };
  }
  if (tool === "review-open") {
    const result = Content.parse(envelope.result);
    const opened = result.content.map((c) => c.text ?? "").join("\n");
    const client = opened.match(
      /(?:client[_ ]?id|client)\s*[:=]\s*[`"']?([\w-]+)/i,
    )?.[1];
    if (!client)
      throw new HttpError(
        502,
        "subtext_invalid",
        "Subtext did not return a review client.",
      );
    await query(
      "UPDATE gateway_contexts SET client_ids=client_ids || $2::jsonb WHERE id=$1",
      [context.id, JSON.stringify([client])],
    );
  }
  return Response.json(envelope, { headers: responseHeaders });
}
