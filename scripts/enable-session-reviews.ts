import { HttpError } from "../src/api/errors.ts";
import { neon } from "@neondatabase/serverless";
import { accountServiceResolver } from "../src/api/account-services.ts";
import { upgradeSessionReviews } from "./lib/enable-session-reviews.ts";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Database not configured");
  const sql = neon(process.env.DATABASE_URL);
  const resolveServices = accountServiceResolver();
  const count = await upgradeSessionReviews(
    async (text, values) => await sql(text, values),
    async (id) => {
      try { return (await resolveServices(id)).qa; }
      catch (error) {
        if (error instanceof HttpError && error.code === "external_qa_not_implemented") return null;
        throw error;
      }
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
