import { createDatabaseFromEnvironment } from "./db.js";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL must be set to run production migrations");
  const database = createDatabaseFromEnvironment();
  await database.loadState(); // PostgresDatabase applies 001 through 003 before this query.
  await database.close?.();
  process.stdout.write("trust-layer migrations applied\n");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown migration failure";
  process.stderr.write(`trust-layer migration failed: ${message}\n`);
  process.exitCode = 1;
});
