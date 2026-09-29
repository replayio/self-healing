import {
  dashboardCookie,
  getDashboardAuth,
  requireDashboardOrigin,
} from "./dashboard-auth.ts";
import { dashboardData } from "./dashboard-data.ts";
import { qaClient } from "./qa.ts";
import { getAccountService } from "./accounts.ts";
import { getConnectionService } from "./connections.ts";
import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.ts";
import { type Authenticator } from "./subtext.ts";
import { z } from "zod";
import {
  agentSkills,
  configurations,
  Id,
  operations,
  type ConfigurationKind,
  type ProjectCreate,
} from "./contracts.ts";
import { getOpenApiSpec } from "./openapi.ts";
import { getStore, type Store } from "./store.ts";

const MAX_BODY_BYTES = 256 * 1024;
async function readBody(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new HttpError(
      415,
      "unsupported_media_type",
      "Use Content-Type: application/json.",
    );
  }
  const reader = request.body?.getReader();
  let text = "",
    bytes = 0;
  const decoder = new TextDecoder();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new HttpError(
            413,
            "body_too_large",
            "Request body exceeds 256 KiB.",
          );
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(
      400,
      "invalid_json",
      "Request body must be valid JSON.",
    );
  }
}
export function createHandler(
  dependencies: {
    store?: () => Store;
    authenticate?: Authenticator;
    connections?: typeof getConnectionService;
    accounts?: typeof getAccountService;
    dashboardAuth?: typeof getDashboardAuth;
    dashboardData?: typeof dashboardData;
  } = {},
) {
  return async (request: Request): Promise<Response> => {
    const requestId = randomUUID();
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "CDN-Cache-Control": "no-store",
      "Netlify-CDN-Cache-Control": "no-store",
      "X-Request-Id": requestId,
    };
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers });
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/$/, "");
      if (path === "/api/v1/openapi.json") {
        if (request.method !== "GET") {
          headers.Allow = "GET";
          throw new HttpError(405, "method_not_allowed", "Use GET.");
        }
        return json(getOpenApiSpec());
      }
      const gateway =
        /^\/api\/internal\/sessions\/([a-f0-9-]{36})\/subtext\/([a-f0-9]{64})$/.exec(
          path,
        );
      if (gateway) {
        if (request.method !== "POST")
          throw new HttpError(405, "method_not_allowed", "Use POST.");
        return (dependencies.connections ?? getConnectionService)().callback(
          Id.parse(gateway[1]),
          gateway[2]!,
          request,
          await readBody(request),
        );
      }
      const matches = operations.flatMap((operation) => {
        const match = new RegExp(
          `^${operation.path.replace(/\{[^}]+\}/g, "([^/]+)")}$`,
        ).exec(path);
        return match ? [{ operation, match }] : [];
      });
      if (!matches.length)
        throw new HttpError(404, "not_found", "API route not found.");
      const route = matches.find(
        (item) => item.operation.method === request.method,
      );
      if (!route) {
        headers.Allow = matches.map((item) => item.operation.method).join(", ");
        throw new HttpError(
          405,
          "method_not_allowed",
          "Method not allowed for this route.",
        );
      }
      const { operation, match } = route;
      if (operation.id === "health")
        return json({ status: "ok", version: "0.1.0", stage: "scaffold" });
      if (operation.id === "discoverApi")
        return json(
          operation.response.parse({
            name: "Self Healing",
            openapi_url: new URL("/api/v1/openapi.json", url).href,
            skills_url: new URL("/api/v1/skills", url).href,
            setup_skill_url: new URL(agentSkills[0].path, url).href,
            instructions:
              "Read the setup skill and OpenAPI specification, then follow the skill to set up this project. Skills are public and do not require credentials.",
            authentication:
              "Provision with a Subtext key using POST /api/v1/accounts. Save the returned Self Healing API key and use it as the bearer credential for subsequent calls. Never place either key in browser code.",
          }),
        );
      if (operation.id === "listSkills")
        return json(
          operation.response.parse({
            skills: agentSkills.map(({ path, ...skill }) => ({
              ...skill,
              url: new URL(path, url).href,
            })),
          }),
        );
      if (operation.id === "provisionAccount") {
        const input = operation.body!.parse(await readBody(request)) as {
          subtext_api_key: string;
        };
        return json(
          await (dependencies.accounts ?? getAccountService)().provisionAccount(
            input.subtext_api_key,
          ),
        );
      }
      const dashboardSession = () =>
        (dependencies.dashboardAuth ?? getDashboardAuth)();
      if (operation.id === "redeemDashboardSession") {
        requireDashboardOrigin(request);
        const input = operation.body!.parse(await readBody(request)) as {
          ticket: string;
        };
        headers["Set-Cookie"] = dashboardCookie(
          await dashboardSession().redeem(input.ticket),
        );
        return json({ ok: true });
      }
      if (operation.id === "logoutDashboard") {
        requireDashboardOrigin(request);
        await dashboardSession().logout(request);
        headers["Set-Cookie"] = dashboardCookie("", 0);
        return json({ ok: true });
      }
      const { accountId: account } = await (
        operation.dashboard && !request.headers.has("authorization")
          ? (req: Request) => dashboardSession().authenticate(req)
          : (dependencies.authenticate ??
              ((req: Request) =>
                (dependencies.accounts ?? getAccountService)().authenticate(
                  req,
                )))
      )(request);
      for (const id of match.slice(1)) Id.parse(id);
      const query = operation.query?.parse(
        Object.fromEntries(url.searchParams),
      ) as { cursor?: string; limit: number } | undefined;
      const body = operation.body
        ? operation.body.parse(await readBody(request))
        : undefined;
      if (operation.id === "createDashboardSession") {
        const connection = await (
          dependencies.connections ?? getConnectionService
        )().get(account);
        if (!connection.ready)
          throw new HttpError(
            409,
            "connection_pending",
            "Finish connection setup first.",
          );
        return json(
          operation.response.parse(await dashboardSession().launch(account)),
        );
      }
      if (operation.dashboard) {
        const credentials = await (
          dependencies.accounts ?? getAccountService
        )().credentials(account);
        const connection = await (
          dependencies.connections ?? getConnectionService
        )(credentials.qaToken).get(account);
        if (!connection.ready)
          throw new HttpError(
            409,
            "connection_pending",
            "Finish connection setup first.",
          );
        const data = (dependencies.dashboardData ?? dashboardData)(
          qaClient({
            ...process.env,
            REPLAY_QA_API_TOKEN: credentials.qaToken,
          }),
        );
        const input = (query ?? {}) as { page?: number; day?: string };
        const result =
          operation.id === "dashboardOverview"
            ? await data.overview(connection)
            : operation.id === "dashboardBugs"
              ? await data.bugs(connection, input.page!)
              : await data.reports(connection, input.day);
        return json(operation.response.parse(result));
      }
      // Planned routes authenticate and validate requests, but never pretend to queue work.
      // No resource data is exposed by this response and no provider request is made.
      if (!operation.implemented)
        throw new HttpError(
          501,
          "not_implemented",
          `${operation.id} requires a provider adapter that is not implemented yet.`,
        );
      if (operation.path.startsWith("/api/v1/connection")) {
        const credentials = await (
          dependencies.accounts ?? getAccountService
        )().credentials(account);
        const service = (dependencies.connections ?? getConnectionService)(
          credentials.qaToken,
        );
        if (operation.id === "connect") {
          const key = credentials.subtextKey;
          return json(
            await service.connect(
              account,
              key,
              body as { name: string; production_url: string },
            ),
          );
        }
        if (operation.id === "connection") {
          const row = await service.get(account);
          return json({
            id: row.id,
            qa_project_id: row.qa_project_id,
            status: row.ready ? "connected" : "pending",
          });
        }
        const action = {
          ingestSession: "session",
          connectionReviews: "reviews",
          connectionReport: "report",
          connectionReports: "reports",
        }[operation.id];
        if (!action) throw new Error("Unmapped connection operation");
        return json(
          await service.action(
            account,
            action,
            (body ?? query ?? {}) as Record<string, unknown>,
          ),
        );
      }
      let store: Store;
      try {
        store = (dependencies.store ?? getStore)();
      } catch {
        throw new HttpError(
          503,
          "storage_unavailable",
          "Project storage is not configured or unavailable.",
        );
      }
      try {
        if (operation.id === "createProject")
          return json(await store.create(account, body as ProjectCreate), 201);
        if (operation.id === "listProjects") {
          const limit = query!.limit;
          const items = await store.list(account, query?.cursor, limit + 1);
          const more = items.length > limit;
          if (more) items.pop();
          return json({ items, next_cursor: more ? items.at(-1)!.id : null });
        }
        const projectId = match[1]!;
        const project = await store.get(account, projectId);
        if (!project)
          throw new HttpError(404, "not_found", "Project not found.");
        if (operation.id === "getProject") return json(project);
        if (operation.id === "updateProject") {
          const updated = await store.update(
            account,
            projectId,
            body as Partial<ProjectCreate>,
          );
          if (!updated)
            throw new HttpError(404, "not_found", "Project not found.");
          return json(updated);
        }
        const kind = path.split("/").at(-1)! as ConfigurationKind;
        if (!(kind in configurations)) throw new Error("Unmapped operation");
        if (request.method === "PUT")
          return json(
            await store.putConfiguration(account, projectId, kind, body),
          );
        const value = await store.getConfiguration(account, projectId, kind);
        if (value === null)
          throw new HttpError(
            404,
            "not_found",
            "Configuration has not been set.",
          );
        return json(value);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        // Never log raw database/provider errors: these may contain credentials or user data.
        throw new HttpError(
          503,
          "storage_unavailable",
          "Project storage is unavailable.",
        );
      }
    } catch (error) {
      const failure =
        error instanceof z.ZodError
          ? new HttpError(
              400,
              "invalid_request",
              error.issues
                .map(
                  (issue) =>
                    `${issue.path.join(".") || "request"}: ${issue.message}`,
                )
                .join("; "),
            )
          : error instanceof HttpError
            ? error
            : new HttpError(
                500,
                "internal_error",
                "An unexpected error occurred.",
              );
      if (failure.status === 401) headers["WWW-Authenticate"] = "Bearer";
      return json(
        {
          error: {
            code: failure.code,
            message: failure.message,
            request_id: requestId,
          },
        },
        failure.status,
      );
    }
  };
}
