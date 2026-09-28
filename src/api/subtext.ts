import { z } from "zod";
import { HttpError } from "./errors.ts";

// Protocol follows fullstorydev/subtext-cli internal/cli/auth.go and
// internal/mcpclient/client.go: auth whoami calls tools/list with this bearer key.
const endpoint = "https://api.fullstory.com/mcp/subtext";
const toolsResult = z.object({
  tools: z.array(z.object({ name: z.string() })),
});
export type SubtextIdentity = { accountId: string };
export type IdentityResolver = (key: string) => Promise<SubtextIdentity>;
export type Authenticator = (request: Request) => Promise<SubtextIdentity>;

export function createSubtextAuthenticator(
  options: {
    request?: typeof fetch;
    resolveIdentity?: IdentityResolver;
  } = {},
): Authenticator {
  return async (request) => {
    const key = /^Bearer ([^\s]+)$/i.exec(
      request.headers.get("authorization") ?? "",
    )?.[1];
    if (!key)
      throw new HttpError(
        401,
        "unauthorized",
        "A Subtext API key is required.",
      );
    let response: Response;
    let rpc: {
      jsonrpc?: string;
      id?: number;
      result?: unknown;
      error?: unknown;
    };
    try {
      response = await (options.request ?? fetch)(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "X-MCP-Format": "json; version=1",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 401 || response.status === 403) {
        throw new HttpError(
          401,
          "unauthorized",
          "Subtext rejected the API key.",
        );
      }
      if (!response.ok) throw new Error("Upstream unavailable");
      rpc = await response.json();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        503,
        "subtext_unavailable",
        "Subtext authentication is unavailable.",
      );
    }
    // Both legacy JSON-RPC and the CLI's JSON-first envelope are supported.
    const envelope = z
      .object({
        ok: z.boolean(),
        data: z.unknown().optional(),
        error: z.object({ code: z.string() }).optional(),
      })
      .safeParse(rpc?.result);
    if (
      envelope.success &&
      !envelope.data.ok &&
      envelope.data.error?.code === "permission_denied"
    ) {
      throw new HttpError(401, "unauthorized", "Subtext rejected the API key.");
    }
    const result = envelope.success
      ? envelope.data.ok
        ? envelope.data.data
        : undefined
      : rpc?.result;
    if (
      rpc?.jsonrpc !== "2.0" ||
      rpc.id !== 1 ||
      rpc.error ||
      (rpc.result as { isError?: boolean } | undefined)?.isError ||
      !toolsResult.safeParse(result).success
    ) {
      throw new HttpError(
        503,
        "subtext_unavailable",
        "Subtext returned an unsupported authentication response.",
      );
    }
    // Successful tools/list proves access, but supplies no stable account/project ID.
    // Do not derive a tenant from the key, an unsigned token claim, or client input.
    if (!options.resolveIdentity) {
      throw new HttpError(
        503,
        "subtext_identity_unavailable",
        "Subtext key verified; account/project identity lookup is not implemented yet.",
      );
    }
    try {
      const identity = await options.resolveIdentity(key);
      return z
        .object({ accountId: z.string().trim().min(1).max(200) })
        .parse(identity);
    } catch {
      throw new HttpError(
        503,
        "subtext_identity_unavailable",
        "Subtext account/project identity lookup is unavailable.",
      );
    }
  };
}

export const authenticateSubtext = createSubtextAuthenticator();
