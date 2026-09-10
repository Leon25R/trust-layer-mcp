import { createDatabaseFromEnvironment } from "./db.js";
import { TrustLayerService } from "./service.js";

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main(): Promise<void> {
  const group = option("--group", "owner-local");
  const database = createDatabaseFromEnvironment();
  const service = new TrustLayerService({ database, secret: process.env.TRUST_LAYER_SECRET });
  const issued = await service.issueSyntheticToken(group, false);
  // Deliberately print the plaintext only once. Do not log the group, digest,
  // token hash, or serialized state.
  process.stdout.write(`${issued.token}\n`);
  await database.close?.();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown token issuance failure";
  process.stderr.write(`trust-layer token issuance failed: ${message}\n`);
  process.exitCode = 1;
});
