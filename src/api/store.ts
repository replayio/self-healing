import { neon } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import type {
  ConfigurationKind,
  ProjectCreate,
  ProjectRecord,
} from "./contracts.ts";

// Minimal query boundary supports Neon in production and real Postgres semantics in tests.
export type Query = (
  text: string,
  values: unknown[],
) => Promise<Record<string, unknown>[]>;
export interface Store {
  list(
    account: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<ProjectRecord[]>;
  get(account: string, id: string): Promise<ProjectRecord | null>;
  create(account: string, input: ProjectCreate): Promise<ProjectRecord>;
  update(
    account: string,
    id: string,
    input: Partial<ProjectCreate>,
  ): Promise<ProjectRecord | null>;
  getConfiguration(
    account: string,
    id: string,
    kind: ConfigurationKind,
  ): Promise<unknown | null>;
  putConfiguration(
    account: string,
    id: string,
    kind: ConfigurationKind,
    value: unknown,
  ): Promise<unknown>;
}
function project(row: Record<string, unknown>): ProjectRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    repository_url: String(row.repository_url),
    production_url: String(row.production_url),
    default_branch: String(row.default_branch),
    created_at: new Date(row.created_at as string).toISOString(),
    updated_at: new Date(row.updated_at as string).toISOString(),
  };
}
export function createStore(query: Query): Store {
  return {
    async list(account, cursor, limit) {
      const rows = await query(
        "SELECT * FROM projects WHERE account_id = $1 AND ($2::uuid IS NULL OR id > $2::uuid) ORDER BY id LIMIT $3",
        [account, cursor ?? null, limit],
      );
      return rows.map(project);
    },
    async get(account, id) {
      const [row] = await query(
        "SELECT * FROM projects WHERE account_id = $1 AND id = $2",
        [account, id],
      );
      return row ? project(row) : null;
    },
    async create(account, input) {
      const [row] = await query(
        "INSERT INTO projects (id, account_id, name, repository_url, production_url, default_branch) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
        [
          randomUUID(),
          account,
          input.name,
          input.repository_url,
          input.production_url,
          input.default_branch,
        ],
      );
      if (!row) throw new Error("Insert did not return project");
      return project(row);
    },
    async update(account, id, input) {
      const [row] = await query(
        `UPDATE projects SET name = COALESCE($3, name), repository_url = COALESCE($4, repository_url),
        production_url = COALESCE($5, production_url), default_branch = COALESCE($6, default_branch), updated_at = now()
        WHERE account_id = $1 AND id = $2 RETURNING *`,
        [
          account,
          id,
          input.name ?? null,
          input.repository_url ?? null,
          input.production_url ?? null,
          input.default_branch ?? null,
        ],
      );
      return row ? project(row) : null;
    },
    async getConfiguration(account, id, kind) {
      const [row] = await query(
        "SELECT value FROM project_configurations WHERE account_id = $1 AND project_id = $2 AND kind = $3",
        [account, id, kind],
      );
      return row?.value ?? null;
    },
    async putConfiguration(account, id, kind, value) {
      const [row] = await query(
        `INSERT INTO project_configurations (account_id, project_id, kind, value) VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (account_id, project_id, kind) DO UPDATE SET value = EXCLUDED.value, updated_at = now() RETURNING value`,
        [account, id, kind, JSON.stringify(value)],
      );
      return row?.value;
    },
  };
}
export function getStore(): Store {
  if (!process.env.DATABASE_URL) throw new Error("Database is not configured");
  const sql = neon(process.env.DATABASE_URL);
  return createStore(
    async (text, values) =>
      (await sql(text, values)) as Record<string, unknown>[],
  );
}
