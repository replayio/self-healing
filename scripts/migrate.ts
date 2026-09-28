import { readFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";
if (!process.env.DATABASE_URL)
  throw new Error("Set DATABASE_URL for the intended environment");
const sql = neon(process.env.DATABASE_URL);
// Bootstrap migration is repeatable. Future schema changes must use numbered migrations.
const migration = await readFile(
  new URL("../migrations/001_initial.sql", import.meta.url),
  "utf8",
);
const statements = migration
  .split(";")
  .map((value) => value.trim())
  .filter(Boolean);
await sql.transaction(statements.map((statement) => sql(statement)));
console.log("Applied 001_initial.sql");
