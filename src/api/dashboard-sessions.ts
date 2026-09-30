import { z } from "zod";
import {
  DashboardSessions,
  DashboardSessionDetail,
  DashboardSessionSnapshot,
} from "./contracts.ts";
import { HttpError } from "./errors.ts";
import type { qaClient } from "./qa.ts";
import type { Connection } from "./connections.ts";
import { normalizeSessionUrl } from "./sessions.ts";

const unavailable = () =>
  new HttpError(
    503,
    "subtext_unavailable",
    "Subtext session data is not available yet. Retry shortly.",
  );
const Content = z.object({
  content: z
    .array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
        data: z.string().optional(),
        mimeType: z.string().optional(),
      }),
    )
    .default([]),
  isError: z.boolean().optional(),
});
const Tool = z.object({
  name: z.string(),
  inputSchema: z
    .object({ properties: z.record(z.unknown()).optional() })
    .optional(),
});

// Same review-open / review-zoom / review-snapshot protocol used by QA's Subtext source.
// Evidence is transient: no session recordings are persisted and credentials stay server-side.
export function dashboardSessions(
  qa: ReturnType<typeof qaClient>,
  key: string,
  request: typeof fetch = fetch,
) {
  async function list(c: Connection, query: Record<string, unknown>) {
    const value = await qa(
      `/api/project-session-reviewers?${new URLSearchParams({ project_id: c.qa_project_id!, sessions: "1", query: JSON.stringify(query) })}`,
    );
    const parsed = DashboardSessions.safeParse(value);
    if (!parsed.success)
      throw new HttpError(
        503,
        "qa_contract_changed",
        "QA returned unexpected session data.",
      );
    return parsed.data;
  }
  async function owned(c: Connection, id: string) {
    // QA filters by project before pagination. Search is substring matching, so require exact ID.
    const deadline = Date.now() + 22000;
    for (let page = 0; ; page++) {
      if (Date.now() > deadline)
        throw new HttpError(
          503,
          "dashboard_busy",
          "Session lookup took too long. Retry shortly.",
        );
      const result = await list(c, { search: id, page });
      const session = result.sessions.find((s) => s.session_id === id);
      if (session) return session;
      if (!result.has_more)
        throw new HttpError(404, "not_found", "Session not found.");
    }
  }
  async function review<T>(
    url: string,
    operation: (
      call: (
        name: string,
        args: Record<string, unknown>,
      ) => Promise<z.infer<typeof Content>>,
      client: string,
      opened: string,
    ) => Promise<T>,
  ) {
    let mcp: string | undefined;
    let seq = 0;
    const signal = AbortSignal.timeout(24000);
    async function rpc(
      method: string,
      params?: unknown,
      notification = false,
    ): Promise<unknown> {
      const response = await request("https://api.fullstory.com/mcp/subtext", {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(mcp ? { "Mcp-Session-Id": mcp } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          ...(notification ? {} : { id: ++seq }),
          method,
          ...(params ? { params } : {}),
        }),
      });
      if (!response.ok) throw unavailable();
      mcp = response.headers.get("mcp-session-id") ?? mcp;
      if (notification || response.status === 202) {
        await response.body?.cancel();
        return {};
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 4_000_000) {
              await reader.cancel();
              throw unavailable();
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
      const text = Buffer.concat(chunks).toString("utf8").trim();
      const json = text.startsWith("{")
        ? text
        : text
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .filter((l) => l && l !== "[DONE]")
            .at(-1)!;
      const envelope = z
        .object({
          result: z.unknown().optional(),
          error: z.unknown().optional(),
        })
        .parse(JSON.parse(json));
      if (envelope.error) throw unavailable();
      return envelope.result;
    }
    let client: string | undefined;
    let call:
      | ((
          name: string,
          args: Record<string, unknown>,
        ) => Promise<z.infer<typeof Content>>)
      | undefined;
    try {
      await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "self-healing-dashboard", version: "1" },
      });
      await rpc("notifications/initialized", undefined, true);
      const tools = z
        .object({ tools: z.array(Tool) })
        .parse(await rpc("tools/list")).tools;
      call = async (name, candidates) => {
        const tool = tools.find((t) => t.name === name);
        if (!tool) throw unavailable();
        const properties = tool.inputSchema?.properties;
        const args = Object.fromEntries(
          Object.entries(candidates).filter(
            ([k]) => !properties || k in properties,
          ),
        );
        const result = Content.parse(
          await rpc("tools/call", { name, arguments: args }),
        );
        if (result.isError) throw unavailable();
        return result;
      };
      const opened = (
        await call("review-open", { url, session_url: url, sessionUrl: url })
      ).content
        .map((c) => c.text ?? "")
        .join("\n");
      client = opened.match(
        /(?:client[_ ]?id|client)\s*[:=]\s*[`"']?([\w-]+)/i,
      )?.[1];
      if (!client) throw unavailable();
      return await operation(call, client, opened);
    } catch {
      throw unavailable();
    } finally {
      if (client && call)
        await call("review-close", {
          client_id: client,
          clientId: client,
          use_case: "view user session",
          was_helpful: true,
        }).catch(() => {});
    }
  }
  return {
    async sessions(c: Connection, day: string, page: number) {
      const from = `${day}T00:00:00.000Z`;
      return list(c, {
        from,
        to: new Date(Date.parse(from) + 86400000).toISOString(),
        page,
      });
    },
    async session(c: Connection, id: string) {
      const session = await owned(c, id);
      return review(
        normalizeSessionUrl(session.session_url),
        async (call, client, opened) => {
          // Ask for every kind in the session map, just as QA does; keep full text as well as timeline rows.
          const resolution: Record<string, string> = {};
          const kinds =
            opened.match(
              /(?:^|\n)\s*kinds:\s*\n?([\s\S]*?)(?=\n\s*(?:tags|#)[:\s]|$)/i,
            )?.[1] ?? "";
          for (const segment of kinds.split(/\n|\s*[·|]\s*/)) {
            const kind = segment.trim().match(/^([a-z][\w-]*)\s+\d+/i)?.[1];
            if (kind) resolution[kind] = "machine";
          }
          if (!Object.keys(resolution).length)
            Object.assign(resolution, {
              navigation: "machine",
              interaction: "machine",
              network: "machine",
              console: "machine",
            });
          const result = await call("review-zoom", {
            client_id: client,
            clientId: client,
            resolution,
          });
          const timeline = result.content.map((c) => c.text ?? "").join("\n");
          const interactions = timeline.split(/\r?\n/).flatMap((line) => {
            const match = line.match(
              /^\s*(\d+)ms\s+((?:page-load|click|change|input|paste|scroll|keydown|keyup|keypress|hover)\b.*)$/i,
            );
            return match
              ? [{ timestamp: Number(match[1]), text: match[2]! }]
              : [];
          });
          return DashboardSessionDetail.parse({
            session,
            timeline,
            interactions,
          });
        },
      );
    },
    async snapshot(c: Connection, id: string, timestamp: number) {
      const session = await owned(c, id);
      return review(
        normalizeSessionUrl(session.session_url),
        async (call, client) => {
          const result = await call("review-snapshot", {
            client_id: client,
            clientId: client,
            timestamp,
            time: timestamp,
            lens: "full",
            include: ["tree", "image"],
            tree: true,
          });
          return DashboardSessionSnapshot.parse({
            tree: result.content
              .map((c) => c.text ?? "")
              .filter(Boolean)
              .join("\n"),
            images: result.content
              .filter(
                (c) =>
                  c.type === "image" &&
                  c.data &&
                  ["image/png", "image/jpeg", "image/webp"].includes(
                    c.mimeType ?? "",
                  ),
              )
              .map((c) => ({ data: c.data!, mime_type: c.mimeType! })),
          });
        },
      );
    },
  };
}
