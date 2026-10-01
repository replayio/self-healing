import type { z } from "zod";

export interface ErrorDiagnostics {
  upstream_status?: number;
  source?: "qa_bug" | "qa_dashboard" | "qa_pipeline";
  issues?: { path: (string | number)[]; code: string; received?: string }[];
}

// Never retain payload values, Zod messages, or unknown exception messages.
export function validationDiagnostics(
  source: NonNullable<ErrorDiagnostics["source"]>,
  error: z.ZodError,
): ErrorDiagnostics {
  return {
    source,
    issues: error.issues.slice(0, 30).map((issue) => ({
      path: issue.path
        .slice(0, 12)
        .map((part) => (typeof part === "string" ? part.slice(0, 80) : part)),
      code: issue.code,
      ...(issue.code === "invalid_type" ? { received: issue.received } : {}),
    })),
  };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly diagnostics: ErrorDiagnostics = {},
  ) {
    super(message);
  }
}
