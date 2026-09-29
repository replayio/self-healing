import { createHash, randomBytes, randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { z } from "zod";
import { credentialVault } from "./credentials.ts";
import { HttpError } from "./errors.ts";
import { qaClient } from "./qa.ts";
import { authenticateSubtext, type Authenticator } from "./subtext.ts";
import type { Query } from "./store.ts";

const AccountRow = z.object({
  id: z.string().uuid(),
  subtext_fingerprint: z.string(),
  encrypted_subtext_key: z.string(),
  api_key_hash: z.string(),
  encrypted_api_key: z.string(),
  encrypted_qa_token: z.string().nullable(),
  qa_issue_attempted: z.boolean(),
});
const IssuedToken = z.object({
  account: z.object({ user_id: z.string() }),
  token: z.object({
    id: z.string(),
    value: z.string().regex(/^lqa_[a-f0-9]{48}$/),
  }),
});
const digest = (key: string) => createHash("sha256").update(key).digest("hex");

export function accountService(
  query: Query,
  vault = credentialVault(),
  validate: Authenticator = authenticateSubtext,
  provision?: ReturnType<typeof qaClient>,
) {
  const get = async (id: string) => {
    const [row] = await query("SELECT * FROM accounts WHERE id=$1", [id]);
    if (!row) throw new HttpError(401, "unauthorized", "Unknown account.");
    return AccountRow.parse(row);
  };
  return {
    async provisionAccount(key: string) {
      await validate(
        new Request("https://self-healing.invalid/provision", {
          headers: { Authorization: `Bearer ${key}` },
        }),
      );
      const fingerprint = vault.identity(key);
      const apiKey = `sh_${randomBytes(32).toString("hex")}`;
      await query(
        `INSERT INTO accounts(id,subtext_fingerprint,encrypted_subtext_key,api_key_hash,encrypted_api_key)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT(subtext_fingerprint) DO NOTHING`,
        [
          randomUUID(),
          fingerprint,
          vault.encrypt(key, fingerprint),
          digest(apiKey),
          vault.encrypt(apiKey, fingerprint),
        ],
      );
      const [row] = await query(
        "SELECT * FROM accounts WHERE subtext_fingerprint=$1",
        [fingerprint],
      );
      let account = AccountRow.parse(row);
      if (!account.encrypted_qa_token) {
        const lease = randomUUID();
        const locked = await query(
          `UPDATE accounts SET lease=$2,lease_until=now()+interval '5 minutes'
          WHERE id=$1 AND (lease_until IS NULL OR lease_until < now()) RETURNING id`,
          [account.id, lease],
        );
        if (!locked.length)
          throw new HttpError(
            409,
            "account_busy",
            "Account provisioning is in progress; retry.",
          );
        try {
          account = await get(account.id);
          if (!account.encrypted_qa_token) {
            if (account.qa_issue_attempted)
              throw new HttpError(
                503,
                "provisioning_pending",
                "Prior QA token issuance is unresolved; operator reconciliation is required.",
              );
            if (!provision && !process.env.REPLAY_QA_PROVISIONING_TOKEN)
              throw new HttpError(
                503,
                "qa_unavailable",
                "QA provisioning credentials are not configured.",
              );
            const issue =
              provision ??
              qaClient({
                ...process.env,
                REPLAY_QA_API_TOKEN: process.env.REPLAY_QA_PROVISIONING_TOKEN,
              });
            await query(
              "UPDATE accounts SET qa_issue_attempted=true WHERE id=$1",
              [account.id],
            );
            const slug = `self-healing-${account.id}`;
            const issued = IssuedToken.parse(
              await issue("/api/admin-service-accounts", {
                action: "issue_token",
                slug,
                name: "Self Healing",
              }),
            );
            if (issued.account.user_id !== `service|${slug}`)
              throw new HttpError(
                503,
                "qa_contract_changed",
                "QA returned a different account identity.",
              );
            await query(
              "UPDATE accounts SET encrypted_qa_token=$2 WHERE id=$1",
              [account.id, vault.encrypt(issued.token.value, fingerprint)],
            );
            account = await get(account.id);
          }
        } finally {
          await query(
            "UPDATE accounts SET lease_until=NULL WHERE id=$1 AND lease=$2",
            [account.id, lease],
          );
        }
      }
      return {
        account_id: account.id,
        api_key: vault.decrypt(account.encrypted_api_key, fingerprint),
      };
    },
    async authenticate(request: Request) {
      const key = /^Bearer (sh_[a-f0-9]{64})$/i.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      if (!key)
        throw new HttpError(
          401,
          "unauthorized",
          "A Self Healing account API key is required.",
        );
      const [row] = await query(
        "SELECT * FROM accounts WHERE api_key_hash=$1 AND encrypted_qa_token IS NOT NULL",
        [digest(key)],
      );
      if (!row)
        throw new HttpError(
          401,
          "unauthorized",
          "Invalid Self Healing account API key.",
        );
      return { accountId: AccountRow.parse(row).id };
    },
    async credentials(id: string) {
      const account = await get(id);
      if (!account.encrypted_qa_token)
        throw new HttpError(
          409,
          "account_pending",
          "Account provisioning is incomplete.",
        );
      return {
        subtextKey: vault.decrypt(
          account.encrypted_subtext_key,
          account.subtext_fingerprint,
        ),
        qaToken: vault.decrypt(
          account.encrypted_qa_token,
          account.subtext_fingerprint,
        ),
      };
    },
  };
}
export function getAccountService() {
  if (!process.env.DATABASE_URL)
    throw new HttpError(
      503,
      "storage_unavailable",
      "Database is not configured.",
    );
  const sql = neon(process.env.DATABASE_URL);
  return accountService(async (text, values) => await sql(text, values));
}
