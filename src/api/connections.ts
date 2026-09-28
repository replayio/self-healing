import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { z } from "zod";
import { credentialVault } from "./credentials.ts";
import { HttpError } from "./errors.ts";
import { qaClient } from "./qa.ts";
import type { Query } from "./store.ts";

const Row = z.object({
  id: z.string().uuid(),
  account_id: z.string(),
  encrypted_key: z.string(),
  name: z.string(),
  production_url: z.string(),
  qa_project_id: z.string().nullable(),
});
export type Connection = z.infer<typeof Row>;
export function connectionService(
  query: Query,
  qa = qaClient(),
  vault = credentialVault(),
) {
  const get = async (account: string) => {
    const [row] = await query(
      "SELECT * FROM connections WHERE account_id = $1",
      [account],
    );
    if (!row)
      throw new HttpError(
        404,
        "not_connected",
        "Connect this Subtext key first.",
      );
    return Row.parse(row);
  };
  return {
    get,
    async connect(
      account: string,
      key: string,
      input: { name: string; production_url: string },
    ) {
      const [row] = await query(
        `INSERT INTO connections (id, account_id, encrypted_key, name, production_url)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT (account_id) DO UPDATE SET account_id = EXCLUDED.account_id RETURNING *`,
        [
          randomUUID(),
          account,
          vault.encrypt(key, account),
          input.name,
          input.production_url,
        ],
      );
      const connection = Row.parse(row);
      if (
        connection.name !== input.name ||
        connection.production_url !== input.production_url
      )
        throw new HttpError(
          409,
          "already_connected",
          "This key is already connected with different project settings.",
        );
      if (connection.qa_project_id)
        return {
          id: connection.id,
          qa_project_id: connection.qa_project_id,
          status: "connected" as const,
        };
      const result = z.object({ project_id: z.string().min(1) }).safeParse(
        await qa({
          action: "connect",
          connection_id: connection.id,
          name: connection.name,
          target_url: connection.production_url,
          gateway_token: vault.gateway(connection.id),
        }),
      );
      if (!result.success)
        throw new HttpError(
          503,
          "qa_unavailable",
          "QA returned an invalid project response.",
        );
      await query("UPDATE connections SET qa_project_id = $2 WHERE id = $1", [
        connection.id,
        result.data.project_id,
      ]);
      return {
        id: connection.id,
        qa_project_id: result.data.project_id,
        status: "connected" as const,
      };
    },
    async action(
      account: string,
      action: string,
      input: Record<string, unknown> = {},
    ) {
      const connection = await get(account);
      if (!connection.qa_project_id)
        throw new HttpError(
          409,
          "connection_pending",
          "Retry the original connection request to finish provisioning.",
        );
      return qa({ ...input, action, connection_id: connection.id });
    },
    async gateway(id: string, token: string) {
      if (!vault.verifyGateway(id, token))
        throw new HttpError(401, "unauthorized", "Invalid gateway credential.");
      const [row] = await query("SELECT * FROM connections WHERE id = $1", [
        id,
      ]);
      if (!row)
        throw new HttpError(401, "unauthorized", "Invalid gateway credential.");
      const connection = Row.parse(row);
      return vault.decrypt(connection.encrypted_key, connection.account_id);
    },
  };
}
export function getConnectionService() {
  if (!process.env.DATABASE_URL)
    throw new HttpError(
      503,
      "storage_unavailable",
      "Database is not configured.",
    );
  const sql = neon(process.env.DATABASE_URL);
  return connectionService(async (text, values) => await sql(text, values));
}
