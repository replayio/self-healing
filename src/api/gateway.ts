import { GatewayRpc, GatewayCall } from "./contracts.ts";
import { HttpError } from "./errors.ts";

// QA receives only a connection-scoped gateway capability. The provider credential
// is decrypted here and is never returned to QA, Obvious, or the browser.
export async function gatewayRequest(
  incoming: Request,
  key: string,
  body: unknown,
  request: typeof fetch = fetch,
) {
  const rpc = GatewayRpc.parse(body);
  if (rpc.method === "tools/call") GatewayCall.parse(rpc.params);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const session = incoming.headers.get("mcp-session-id");
  if (session) headers["Mcp-Session-Id"] = session;
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
    throw new HttpError(
      503,
      "subtext_unavailable",
      "Subtext gateway is unavailable.",
    );
  }
  if (!response.ok)
    throw new HttpError(
      [400, 401, 403, 404, 429].includes(response.status)
        ? response.status
        : 503,
      "subtext_unavailable",
      "Subtext rejected the gateway request.",
    );
  const resultHeaders: Record<string, string> = {
    "Content-Type": response.headers.get("content-type") ?? "application/json",
    "Cache-Control": "no-store",
  };
  const nextSession = response.headers.get("mcp-session-id");
  if (nextSession) resultHeaders["Mcp-Session-Id"] = nextSession;
  // Stream provider results without recording session material in our coordination DB.
  return new Response(response.body, {
    status: response.status,
    headers: resultHeaders,
  });
}
