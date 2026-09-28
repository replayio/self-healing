import { zodToJsonSchema } from "zod-to-json-schema";
import { type z } from "zod";
import { ErrorResponse, operations } from "./contracts.ts";

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
      schema: { type: "string", format: "uuid" },
    }));
    if (operation.query) {
      const query = schema(operation.query) as {
        properties?: Record<string, unknown>;
      };
      for (const [name, value] of Object.entries(query.properties ?? {})) {
        parameters.push({ name, in: "query", required: false, schema: value });
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
      413: "Body exceeds 256 KiB",
      415: "Expected application/json",
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
          : "Requires Subtext account/project identity resolution, which is currently pending. Valid keys receive 503 until that adapter is implemented.",
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
      security: operation.public ? [] : [{ bearerAuth: [] }],
      parameters,
      ...(operation.body
        ? { requestBody: { required: true, content: content(operation.body) } }
        : {}),
      responses,
    };
  }
  for (const name of ["setup-self-healing", "operate-self-healing"]) {
    paths[`/api/v1/skills/${name}/SKILL.md`] = {
      get: {
        operationId: name,
        summary: `Read ${name} agent skill`,
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
        "Experimental factory coordination API. Project and configuration storage require verified Subtext identity; provider operations are explicit 501 contracts. The factory supplies its Subtext API key as a bearer token. No Self Healing keys are issued or configured. Subtext key verification is implemented; stable account/project identity resolution is pending, so protected operations currently fail closed with 503 after a valid key is verified. PUT is idempotent replacement. POST has no automatic retry guarantee. Lists use exclusive opaque cursors and bounded page sizes.",
    },
    servers: [{ url: "/" }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "Your Subtext API key. Keep it server-side; never embed it in browser monitoring.",
        },
      },
    },
  };
}
