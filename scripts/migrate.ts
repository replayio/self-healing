import { readFile, readdir } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";
if (!process.env.DATABASE_URL)
  throw new Error("Set DATABASE_URL for the intended environment");
const sql = neon(process.env.DATABASE_URL);
// All migrations are repeatable; apply each file atomically in numeric order.
const directory = new URL("../migrations/", import.meta.url);
for (const name of (await readdir(directory))
  .filter((name) => /^\d+_.*\.sql$/.test(name))
  .sort()) {
  const migration = await readFile(new URL(name, directory), "utf8");
  const statements = migration
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  await sql.transaction(statements.map((statement) => sql(statement)));
  console.log(`Applied ${name}`);
}
