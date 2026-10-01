import { neon } from "@neondatabase/serverless";
import type { Query } from "./store.ts";
import type { ErrorDiagnostics } from "./errors.ts";

export interface ServiceErrorRecord {
  request_id: string;
  account_id: string | null;
  operation: string;
  status: number;
  code: string;
  bug_id: string | null;
  diagnostics: ErrorDiagnostics;
}

export function serviceErrorStore(query: Query) {
  return {
    async record(error: ServiceErrorRecord) {
      await query(
        `INSERT INTO service_errors
         (request_id, account_id, operation, status, code, bug_id, diagnostics)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (request_id) DO NOTHING`,
        [
          error.request_id,
          error.account_id,
          error.operation,
          error.status,
          error.code,
          error.bug_id,
          JSON.stringify(error.diagnostics),
        ],
      );
    },
    async find(account: string, requestId: string) {
      const [row] = await query(
        "SELECT * FROM service_errors WHERE account_id = $1 AND request_id = $2",
        [account, requestId],
      );
      return row ?? null;
    },
  };
}

export function getServiceErrorStore() {
  if (!process.env.DATABASE_URL) throw new Error("Database is not configured");
  const sql = neon(process.env.DATABASE_URL);
  return serviceErrorStore(
    async (text, values) =>
      (await sql(text, values)) as Record<string, unknown>[],
  );
}
