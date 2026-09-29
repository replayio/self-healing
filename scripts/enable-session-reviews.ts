import { neon } from "@neondatabase/serverless";
import { getAccountService } from "../src/api/accounts.ts";
import { qaClient } from "../src/api/qa.ts";
import { upgradeSessionReviews } from "./lib/enable-session-reviews.ts";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Database not configured");
  const sql = neon(process.env.DATABASE_URL);
  const accounts = getAccountService();
  const count = await upgradeSessionReviews(
    async (text, values) => await sql(text, values),
    async (id) => {
      const { qaToken } = await accounts.credentials(id);
      return qaClient({ ...process.env, REPLAY_QA_API_TOKEN: qaToken });
    },
  );
  console.log(
    `Enabled automatic session reviews for ${count} existing connections.`,
  );
}
void main().catch(() => {
  console.error("Automatic review configuration failed; retry the deployment.");
  process.exitCode = 1;
});
