import { requireAccountWork } from "./account-policy.ts";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { credentialVault } from "./credentials.ts";
import { HttpError } from "./errors.ts";
import { type QAClient } from "./qa.ts";
import { gatewayRequest } from "./gateway.ts";
import type { Connection } from "./connections.ts";
import type { Query } from "./store.ts";
import { AuxiliaryArtifact } from "./contracts.ts";

export function normalizeSessionUrl(raw: string) {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    !["app.fullstory.com", "app.eu1.fullstory.com"].includes(url.hostname) ||
    url.username ||
    url.password ||
    !/(?:client-session|session|trace)\//.test(url.pathname)
  )
    throw new HttpError(400, "invalid_session", "Use a Fullstory session URL.");
  url.hash = "";
  return url.toString();
}
const Input = z.object({
  session_url: z.string(),
  auxiliary_data: z.array(AuxiliaryArtifact).default([]),
  complete: z.boolean().default(false),
});
const Session = z.object({
  id: z.string().uuid(),
  connection_id: z.string().uuid(),
  session_url: z.string(),
  qa_session_id: z.string().nullable(),
  sealed: z.boolean(),
  review_request_id: z.string().uuid(),
});
export function sessionService(
  query: Query,
  qa: QAClient,
  vault: ReturnType<typeof credentialVault>,
  origin: string,
  authorizeWork: (accountId: string) => Promise<void> = requireAccountWork,
) {
  const base = new URL(origin);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new HttpError(
      503,
      "callback_unavailable",
      "SELF_HEALING_URL must be an HTTPS origin.",
    );
  return {
    async ingest(c: Connection, raw: unknown) {
      const input = Input.parse(raw);
      const url = normalizeSessionUrl(input.session_url);
      const [row] = await query(
        `INSERT INTO sessions(id, connection_id, session_url, review_request_id) VALUES ($1,$2,$3,$4)
        ON CONFLICT(connection_id, session_url) DO UPDATE SET session_url=EXCLUDED.session_url RETURNING *`,
        [randomUUID(), c.id, url, randomUUID()],
      );
      let session = Session.parse(row);
      const lease = randomUUID();
      const locks = await query(
        `UPDATE sessions SET lease=$2, lease_until=now()+interval '5 minutes'
        WHERE id=$1 AND (lease_until IS NULL OR lease_until<now()) RETURNING *`,
        [session.id, lease],
      );
      if (!locks.length)
        throw new HttpError(
          409,
          "upload_busy",
          "Retry after the current upload finishes.",
        );
      session = Session.parse(locks[0]);
      const digest = createHash("sha256")
        .update(JSON.stringify({ ...input, session_url: url }))
        .digest("hex");
      try {
        const [receipt] = await query(
          "SELECT ingested,result FROM upload_receipts WHERE session_id=$1 AND digest=$2",
          [session.id, digest],
        );
        const prior = z
          .object({
            ingested: z.boolean(),
            result: z.record(z.unknown()).nullable(),
          })
          .optional()
          .parse(receipt);
        if (prior?.result) return prior.result;
        if (!prior?.ingested) {
          if (!c.encrypted_ingest_token)
            throw new HttpError(
              503,
              "connection_pending",
              "Session ingestion is not configured.",
            );
          const registered = z.object({ session_id: z.string().min(1) }).parse(
            await qa(
              "/api/project-session/register",
              {
                session_url: url,
                auxiliary_data: input.auxiliary_data,
                source_callback_url: `${base.origin}/api/internal/sessions/${session.id}/subtext/${vault.gateway(session.id)}`,
              },
              vault.decrypt(c.encrypted_ingest_token, c.account_id),
            ),
          );
          await query("UPDATE sessions SET qa_session_id=$2 WHERE id=$1", [
            session.id,
            registered.session_id,
          ]);
          session.qa_session_id = registered.session_id;
          await query(
            "INSERT INTO upload_receipts(session_id,digest,ingested) VALUES ($1,$2,true) ON CONFLICT DO NOTHING",
            [session.id, digest],
          );
        }
        // Every successful registration updates QA's last_received_at. Its enabled
        // reviewers schedule once the stream is quiet; callers never finalize or seal it.
        const result = {
          session_id: session.qa_session_id,
          status: "stored",
        };
        await query(
          "UPDATE upload_receipts SET result=$3::jsonb WHERE session_id=$1 AND digest=$2",
          [session.id, digest, JSON.stringify(result)],
        );
        return result;
      } finally {
        await query(
          "UPDATE sessions SET lease_until=NULL WHERE id=$1 AND lease=$2",
          [session.id, lease],
        );
      }
    },
    async callback(
      id: string,
      token: string,
      request: Request,
      body: unknown,
      fetcher: typeof fetch = fetch,
    ) {
      if (!vault.verifyGateway(id, token))
        throw new HttpError(401, "unauthorized", "Invalid session callback.");
      const [row] = await query(
        `SELECT s.*, c.account_id, c.encrypted_key, COALESCE(a.subtext_fingerprint, c.account_id) AS credential_binding FROM sessions s
        JOIN connections c ON c.id=s.connection_id LEFT JOIN accounts a ON a.id::text=c.account_id WHERE s.id=$1`,
        [id],
      );
      if (!row)
        throw new HttpError(401, "unauthorized", "Invalid session callback.");
      const session = Session.extend({
        account_id: z.string(),
        encrypted_key: z.string(),
        credential_binding: z.string(),
      }).parse(row);
      await authorizeWork(session.account_id);
      return gatewayRequest(
        request,
        vault.decrypt(session.encrypted_key, session.credential_binding),
        body,
        { sessionId: id, sessionUrl: session.session_url, query, vault },
        fetcher,
      );
    },
  };
}
