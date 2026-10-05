import { getServiceErrorStore } from "./service-errors.ts";
import { getFixPrStore } from "./fix-prs.ts";
import { dashboardSessions } from "./dashboard-sessions.ts";
import {
  dashboardCookie,
  getDashboardAuth,
  requireDashboardOrigin,
} from "./dashboard-auth.ts";
import { dashboardData } from "./dashboard-data.ts";
import { pipelineData } from "./pipeline.ts";
import { BugUpdateInput, FixPrInput, VerificationInput } from "./contracts.ts";
import {
  accountServiceResolver,
  type AccountServiceResolver,
} from "./account-services.ts";
import { getDataConfigStore } from "./data-config.ts";
import { DataConfigInput, DataConfigStatus } from "./contracts.ts";
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
    services?: AccountServiceResolver;
    dataConfigs?: typeof getDataConfigStore;
    store?: () => Store;
    serviceErrors?: typeof getServiceErrorStore;
    authenticate?: Authenticator;
    connections?: typeof getConnectionService;
    accounts?: typeof getAccountService;
    dashboardAuth?: typeof getDashboardAuth;
    dashboardData?: typeof dashboardData;
    dashboardSessions?: typeof dashboardSessions;
    pipelineData?: typeof pipelineData;
    fixPrs?: typeof getFixPrStore;
  } = {},
) {
  const resolveServices =
    dependencies.services ?? accountServiceResolver(dependencies);
  return async (request: Request): Promise<Response> => {
    const requestId = randomUUID();
    let errorAccount: string | null = null;
    let errorOperation = "unmatched";
    let errorBug: string | null = null;
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
        errorOperation = "sessionGateway";
        if (request.method !== "POST")
          throw new HttpError(405, "method_not_allowed", "Use POST.");
        return await (
          dependencies.connections ?? getConnectionService
        )().callback(
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
      errorOperation = operation.id;
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
        const raw = await readBody(request);
        const parsed = operation.body!.safeParse(raw);
        if (!parsed.success) {
          const ticket = z.object({ ticket: z.unknown() }).safeParse(raw);
          const value = ticket.success ? ticket.data.ticket : undefined;
          const detail =
            typeof value !== "string"
              ? "No dashboard access code was received."
              : value.length !== 64
                ? `The dashboard received an access code with ${value.length} characters; it must contain exactly 64.`
                : !/^[a-f0-9]{64}$/.test(value)
                  ? "The dashboard access code contains characters it cannot accept. It must contain only lowercase letters a–f and digits 0–9."
                  : "The dashboard received an unexpected link-opening request.";
          throw new HttpError(
            400,
            "invalid_dashboard_link",
            `${detail} If this dashboard is embedded in your factory, have the factory use the exact URL returned by Self Healing without shortening or rebuilding it. You can also try opening that same URL directly in your browser.`,
          );
        }
        const input = parsed.data as { ticket: string };
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
      errorAccount = account;
      const pathNames = [...operation.path.matchAll(/\{([^}]+)\}/g)].map(
        (m) => m[1]!,
      );
      const pathValues = Object.fromEntries(
        pathNames.map((name, index) => [
          name,
          (operation.pathParameters?.[name] ?? Id).parse(match[index + 1]),
        ]),
      );
      const query = operation.query?.parse(
        Object.fromEntries(url.searchParams),
      ) as { cursor?: string; limit: number } | undefined;
      const body = operation.body
        ? operation.body.parse(await readBody(request))
        : undefined;
      // Only retain the validated bug identifier, never request bodies or URLs.
      const bugContext = (body ?? query ?? {}) as { bug_id?: string };
      errorBug = pathValues.bug_id ?? bugContext.bug_id ?? null;
      if (
        operation.id === "getDataConfig" ||
        operation.id === "putDataConfig"
      ) {
        const configs = (dependencies.dataConfigs ?? getDataConfigStore)();
        const status =
          operation.id === "getDataConfig"
            ? await configs.status(account)
            : await configs.put(account, DataConfigInput.parse(body));
        return json(DataConfigStatus.parse(status));
      }
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
      if (operation.pipeline) {
        const services = await resolveServices(account);
        const connection = await services.connections.get(account);
        if (!connection.ready)
          throw new HttpError(
            409,
            "connection_pending",
            "Finish connection setup first.",
          );
        const data = (dependencies.pipelineData ?? pipelineData)(
          services.qa,
          undefined,
          dependencies.fixPrs ?? getFixPrStore,
        );
        const input = (body ?? query ?? {}) as {
          page?: number;
          bug_id?: string;
        };
        const result =
          operation.id === "pipelineBugs"
            ? await data.bugs(connection, input.page!)
            : operation.id === "pipelineBug"
              ? await data.bug(connection, input.bug_id!)
              : operation.id === "pipelineUpdateBug"
                ? await data.updateBug(
                    connection,
                    pathValues.bug_id,
                    BugUpdateInput.parse(body),
                  )
                : operation.id === "pipelineAssociatePr"
                  ? await data.associatePr(connection, FixPrInput.parse(body))
                  : operation.id === "pipelineVerify"
                    ? await data.verify(
                        connection,
                        VerificationInput.parse(body),
                      )
                    : await data.verifications(
                        connection,
                        input.bug_id!,
                        input.page!,
                      );
        return json(operation.response.parse(result), operation.status ?? 200);
      }
      if (operation.dashboard) {
        const services = await resolveServices(account);
        const connection = await services.connections.get(account);
        if (!connection.ready)
          throw new HttpError(
            409,
            "connection_pending",
            "Finish connection setup first.",
          );
        const qa = services.qa;
        const sessionData = (
          dependencies.dashboardSessions ?? dashboardSessions
        )(qa, services.subtextKey);
        const data = (dependencies.dashboardData ?? dashboardData)(
          qa,
          Date.now(),
          dependencies.fixPrs ?? getFixPrStore,
        );
        const input = (query ?? {}) as {
          page?: number;
          status?: "open" | "closed";
          day?: string;
          bug_id?: string;
          session_id?: string;
          timestamp?: number;
        };
        const result =
          operation.id === "dashboardSessions"
            ? await sessionData.sessions(connection, input.day!, input.page!)
            : operation.id === "dashboardSession"
              ? await sessionData.session(connection, input.session_id!)
              : operation.id === "dashboardSessionSnapshot"
                ? await sessionData.snapshot(
                    connection,
                    input.session_id!,
                    input.timestamp!,
                  )
                : operation.id === "dashboardOverview"
                  ? await data.overview(connection)
                  : operation.id === "dashboardBugs"
                    ? await data.bugs(connection, input.page!, input.status)
                    : operation.id === "dashboardBug"
                      ? await data.bug(connection, input.bug_id!)
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
        const services = await resolveServices(account);
        const service = services.connections;
        if (operation.id === "connect") {
          const key = services.subtextKey;
          return json(
            await service.connect(
              account,
              key,
              body as {
                name: string;
                production_url: string;
                start_exploration?: boolean;
              },
            ),
          );
        }
        if (operation.id === "connection") {
          const row = await service.get(account);
          return json({
            id: row.id,
            qa_project_id: row.qa_project_id,
            start_exploration: row.start_exploration,
            status: row.ready ? "connected" : "pending",
          });
        }
        const action = {
          getReportDestinations: "reportDestinations",
          updateReportDestinations: "updateReportDestinations",
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
      if (failure.status >= 500 && failure.status !== 501) {
        const record = {
          request_id: requestId,
          account_id: errorAccount,
          operation: errorOperation,
          status: failure.status,
          code: failure.code,
          bug_id: errorBug,
          diagnostics: failure.diagnostics,
        };
        try {
          await (dependencies.serviceErrors ?? getServiceErrorStore)().record(
            record,
          );
        } catch {
          // Database outages must not replace the original error or leak SQL/credentials.
          console.error("service_error_persistence_failed", record);
        }
      }
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
