import { zodToJsonSchema } from "zod-to-json-schema";
import { type z } from "zod";
import { agentSkills, ErrorResponse, operations } from "./contracts.ts";

const schema = (value: z.ZodTypeAny) =>
  zodToJsonSchema(value, { target: "openApi3", $refStrategy: "none" });
const content = (value: z.ZodTypeAny) => ({
  "application/json": { schema: schema(value) },
});
export function getOpenApiSpec() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    const parameters: unknown[] = [
      ...operation.path.matchAll(/\{([^}]+)\}/g),
    ].map((match) => ({
      name: match[1],
      in: "path",
      required: true,
      schema: operation.pathParameters?.[match[1]!]
        ? schema(operation.pathParameters[match[1]!]!)
        : { type: "string", format: "uuid" },
    }));
    if (operation.query) {
      const query = schema(operation.query) as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      for (const [name, value] of Object.entries(query.properties ?? {})) {
        parameters.push({
          name,
          in: "query",
          required: query.required?.includes(name) ?? false,
          schema: value,
        });
      }
    }
    const responses: Record<string, unknown> = {};
    for (const [status, description] of Object.entries({
      400: "Invalid request",
      401: "Missing or invalid bearer key",
      404: "Resource not found",
      405: "Method not allowed",
      409: "Conflict",
      410: "Expired event cursor",
      415: "Expected application/json",
      429: "QA review capacity unavailable; retry with backoff",
      500: "Internal error",
      503: "Service not configured or database unavailable",
    }))
      responses[status] = { description, content: content(ErrorResponse) };
    responses[String(operation.status ?? 200)] = {
      description: operation.implemented
        ? "Success"
        : "Planned success response; not returned by this scaffold",
      content: content(operation.response),
    };
    if (!operation.implemented)
      responses["501"] = {
        description: "Provider adapter is not implemented; no work was queued",
        content: content(ErrorResponse),
      };
    (paths[operation.path] ??= {})[operation.method.toLowerCase()] = {
      operationId: operation.id,
      summary: operation.summary,
      description: [
        operation.public
          ? undefined
          : operation.dashboard
            ? "Use the read-only dashboard cookie or the account bearer key."
            : "Supply the Self Healing account API key returned by provisionAccount as a bearer credential.",
        operation.description,
        operation.implemented
          ? ""
          : "CONTRACT ONLY: valid authorized requests currently return 501.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      "x-implementation-status": operation.implemented
        ? "implemented"
        : "planned",
      security: operation.public
        ? []
        : operation.dashboard
          ? [{ dashboardCookie: [] }, { bearerAuth: [] }]
          : [{ bearerAuth: [] }],
      parameters,
      ...(operation.body
        ? { requestBody: { required: true, content: content(operation.body) } }
        : {}),
      responses,
    };
  }
  for (const skill of agentSkills) {
    paths[skill.path] = {
      get: {
        operationId: skill.id,
        summary: skill.name,
        description: skill.description,
        security: [],
        responses: {
          200: {
            description: "Public agent instructions",
            content: { "text/markdown": { schema: { type: "string" } } },
          },
        },
      },
    };
  }
  return {
    openapi: "3.0.3",
    info: {
      title: "Self Healing API",
      version: "0.1.0",
      description:
        "Factories provision with a Subtext key, then authenticate with the returned Self Healing account key. Each account has a dedicated QA identity. The connection API provisions one QA project per account and mediates session ingestion, reviews and daily reports. QA accesses Subtext through Self Healing. Legacy project provider operations remain explicit 501 contracts. Retry connection and session requests with identical bodies.",
    },
    externalDocs: {
      description: "Start here: read the setup skill to configure this project",
      url: agentSkills[0].path,
    },
    "x-agent-skills": { catalog: "/api/v1/skills", setup: agentSkills[0].path },
    servers: [{ url: "/" }],
    paths,
    components: {
      securitySchemes: {
        dashboardCookie: {
          type: "apiKey",
          in: "cookie",
          name: "__Host-sh-dashboard",
          description: "Read-only, 24-hour dashboard browser session.",
        },
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "Your Self Healing account API key. Keep it server-side; never embed it in browser monitoring.",
        },
      },
    },
  };
}
