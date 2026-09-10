import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { newDb, type IMemoryDb } from "pg-mem";
import type { OAuthState, StoreState } from "./types.js";

const TABLES = [
  "participants", "sites", "site_aggregates", "site_aggregate_daily_rollups",
  "assessment_event_receipts", "research_manifests", "source_decisions",
  "manifest_id_tombstones", "verification_jobs", "site_verification_daily_rollups",
  "aggregate_corrections", "domain_holds", "model_family_map", "model_calibration_aggregates",
] as const;

const DELETE_ORDER = [
  "source_decisions", "assessment_event_receipts", "site_aggregate_daily_rollups",
  "site_verification_daily_rollups", "aggregate_corrections", "domain_holds", "site_aggregates",
  "sites", "research_manifests", "manifest_id_tombstones", "verification_jobs",
  "model_calibration_aggregates", "model_family_map", "participants",
] as const;

export interface TrustLayerDatabase {
  loadState(): StoreState | null | Promise<StoreState | null>;
  saveState(state: StoreState): void | Promise<void>;
  loadOAuthState(): OAuthState | null | Promise<OAuthState | null>;
  saveOAuthState(state: OAuthState): void | Promise<void>;
  close?(): Promise<void>;
}

export interface PostgresQueryResult { rows: unknown[]; }

export interface PostgresClient {
  query(statement: string, values?: readonly unknown[]): Promise<PostgresQueryResult>;
  release(): void;
}

export interface PostgresPool {
  connect(): Promise<PostgresClient>;
  end(): Promise<void>;
}

function quote(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function json(value: unknown): string { return `${quote(JSON.stringify(value))}::jsonb`; }
function bytea(hash: string): string { return quote(hash); }

function migrationPath(name: "001_trust_layer.sql" | "002_runtime_state.sql" | "003_guidance_version.sql"): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, `../migrations/${name}`),
    join(moduleDir, `../../migrations/${name}`),
    resolve(process.cwd(), `migrations/${name}`),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`migration file not found: ${name}`);
  return found;
}

function sqlStatements(sql: string): string[] {
  return sql.replace(/^\s*--.*$/gm, "").split(";").map((statement) => statement.trim()).filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasRecordProperties(value: unknown, properties: readonly string[]): value is Record<string, Record<string, unknown>> {
  return isRecord(value) && properties.every((property) => isRecord(value[property]));
}

function decodeStoreState(value: unknown): StoreState | null {
  const decoded = typeof value === "string" ? parseJson(value) : value;
  const properties = [
    "participants", "sites", "aggregates", "rollups", "receipts", "manifests", "sourceDecisions",
    "tombstones", "verifications", "holds", "inputUsage", "assessmentUsage", "modelFamilyMap",
    "receiptByTokenDomain", "receiptByResearchId",
  ];
  return hasRecordProperties(decoded, properties) ? (decoded as unknown as StoreState) : null;
}

function decodeOAuthState(value: unknown): OAuthState | null {
  const decoded = typeof value === "string" ? parseJson(value) : value;
  return hasRecordProperties(decoded, ["clients", "authorizationCodes", "refreshTokens"]) ? (decoded as unknown as OAuthState) : null;
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

/** SQL statements that materialize the privacy-minimized canonical tables. */
function persistenceStatements(state: StoreState): string[] {
  const statements: string[] = DELETE_ORDER.map((table) => `DELETE FROM ${table}`);
  for (const participant of Object.values(state.participants)) statements.push(`INSERT INTO participants (participant_id, token_hash, invite_origin_group, issued_at, mature_at, stopped_at, detail_consent) VALUES (${quote(participant.participantId)}, ${bytea(participant.tokenHash)}, ${quote(participant.inviteOriginGroup)}, ${quote(participant.issuedAt)}, ${quote(participant.matureAt)}, ${quote(participant.stoppedAt)}, ${quote(participant.detailConsent)})`);
  for (const site of Object.values(state.sites)) statements.push(`INSERT INTO sites (domain, first_observed_at, state, state_reason) VALUES (${quote(site.domain)}, ${quote(site.firstObservedAt)}, ${quote(state.aggregates[site.domain]?.state ?? "insufficient")}, ${quote(state.aggregates[site.domain]?.stateReason ?? "insufficient_volume")})`);
  for (const aggregate of Object.values(state.aggregates)) statements.push(`INSERT INTO site_aggregates (domain, aggregate_window, support_weight, rejection_weight, insufficient_weight, provenance_group_count, model_family_count, max_group_share, evidence_coverage, verification_coverage, state, state_reason, secondary_state_reasons, last_observed_at, last_evaluated_at) VALUES (${quote(aggregate.domain)}, 'rolling_90d', ${aggregate.support}, ${aggregate.rejection}, ${aggregate.insufficient}, ${aggregate.groupCount}, ${aggregate.familyCount}, ${aggregate.maxGroupShare}, ${quote(aggregate.evidenceCoverage)}, ${quote(aggregate.verificationCoverage)}, ${quote(aggregate.state)}, ${quote(aggregate.stateReason)}, ${json(aggregate.secondaryStateReasons)}, ${quote(aggregate.lastObservedAt)}, ${quote(aggregate.lastEvaluatedAt)})`);
  for (const rollup of Object.values(state.rollups)) statements.push(`INSERT INTO site_aggregate_daily_rollups (domain, observed_utc_date, provenance_group_hash, agent_model_family, support_weight, rejection_weight, insufficient_weight, minimal_count, manifest_count, correction_delta) VALUES (${quote(rollup.domain)}, ${quote(rollup.observedDate)}, ${bytea(rollup.provenanceGroupHash)}, ${quote(rollup.modelFamily)}, ${rollup.support}, ${rollup.rejection}, ${rollup.insufficient}, ${rollup.minimalCount}, ${rollup.manifestCount}, 0)`);
  for (const receipt of Object.values(state.receipts)) statements.push(`INSERT INTO assessment_event_receipts (receipt_id, domain, outcome, reason_code, rubric_version, guidance_version, token_hash, provenance_group_hash, agent_model_name, agent_model_family, applied_weight, event_hmac, observed_at, research_id) VALUES (${quote(receipt.receiptId)}, ${quote(receipt.domain)}, ${quote(receipt.outcome)}, ${quote(receipt.reasonCode)}, ${quote(receipt.rubricVersion)}, ${quote(receipt.guidanceVersion)}, ${bytea(receipt.tokenHash)}, ${bytea(receipt.provenanceGroupHash)}, ${quote(receipt.modelName)}, ${quote(receipt.modelFamily)}, ${receipt.appliedWeight}, ${bytea(receipt.tokenHash)}, ${quote(receipt.observedAt)}, ${quote(receipt.researchId)})`);
  for (const manifest of Object.values(state.manifests)) statements.push(`INSERT INTO research_manifests (research_id, intent_category, claim_scope_tags, sensitivity, source_count_total, batch_count, batch_state, first_accepted_at, token_hash, rubric_version, guidance_version, collection_mode, final_domain, final_outcome, final_reason_code) VALUES (${quote(manifest.researchId)}, ${quote(manifest.questionContext.intent_category)}, ${json(manifest.questionContext.claim_scope_tags)}, ${quote(manifest.questionContext.sensitivity)}, ${manifest.sourceCountTotal}, ${manifest.batchCount}, ${quote(manifest.state)}, ${quote(manifest.firstAcceptedAt)}, ${bytea(manifest.tokenHash)}, ${quote(manifest.rubricVersion)}, ${quote(manifest.guidanceVersion)}, ${quote(manifest.collectionMode)}, ${quote(manifest.finalAssessment?.domain)}, ${quote(manifest.finalAssessment?.outcome)}, ${quote(manifest.finalAssessment?.reason_code)})`);
  for (const source of Object.values(state.sourceDecisions)) statements.push(`INSERT INTO source_decisions (research_id, source_ref, domain, url_scope, canonical_url, source_disposition, reason_codes, related_source_refs, source_type, published_date_precision) VALUES (${quote(source.researchId)}, ${quote(source.source_ref)}, ${quote(source.domain)}, ${quote(source.url_scope)}, ${quote(source.canonical_url)}, ${quote(source.source_disposition)}, ${json(source.reason_codes)}, ${json(source.related_source_refs)}, ${quote(source.source_type)}, ${quote(source.published_date_precision)})`);
  for (const tombstone of Object.values(state.tombstones)) statements.push(`INSERT INTO manifest_id_tombstones (research_id_hmac, tombstone_state, created_at, expires_at) VALUES (${bytea(tombstone.researchIdHmac)}, ${quote(tombstone.state)}, ${quote(tombstone.createdAt)}, ${quote(tombstone.expiresAt)})`);
  for (const verification of Object.values(state.verifications)) statements.push(`INSERT INTO verification_jobs (attestation_id, domain, selected_reason, checked_source_refs, fixed_result, counterevidence_state, audit_case_id, model_family, completed_at) SELECT ${quote(verification.attestationId)}, ${quote(state.manifests[verification.researchId]?.finalAssessment?.domain ?? "unknown.example")}, 'self_report', ${json(verification.checkedSourceRefs)}, ${quote(verification.result)}, 'none', NULL, 'unknown', ${quote(verification.completedAt)}::timestamptz`);
  for (const hold of Object.values(state.holds)) statements.push(`INSERT INTO domain_holds (domain, hold_state, reason, started_at, signal_version, evidence_ref, release_role, release_condition, expires_at, released_at, released_by_role) VALUES (${quote(hold.domain)}, ${quote(hold.holdState)}, ${quote(hold.reason)}, ${quote(hold.startedAt)}, '0.3', NULL, 'business_owner_and_data_steward', 'explicit_review', ${quote(hold.expiresAt)}, ${quote(hold.releasedAt)}, NULL)`);
  for (const [modelName, modelFamily] of Object.entries(state.modelFamilyMap)) statements.push(`INSERT INTO model_family_map (model_name, model_family, map_version, effective_from) VALUES (${quote(modelName)}, ${quote(modelFamily)}, '0.3', '1970-01-01T00:00:00.000Z')`);
  return statements;
}

/** Synchronous adapter used only by tests and local development. */
export class PostgresCompatDatabase implements TrustLayerDatabase {
  readonly db: IMemoryDb;
  readonly filePath: string | null;
  readonly migrationPath: string;
  private lastTransactionTableCount = 0;
  private oauthState: OAuthState | null = null;

  constructor(options: { filePath?: string | null; migrationPath?: string } = {}) {
    this.filePath = options.filePath ?? null;
    this.migrationPath = options.migrationPath ?? migrationPath("001_trust_layer.sql");
    this.db = newDb({ autoCreateForeignKeyIndices: true });
    for (const statement of sqlStatements(readFileSync(this.migrationPath, "utf8"))) this.db.public.none(statement);
    for (const statement of sqlStatements(readFileSync(migrationPath("002_runtime_state.sql"), "utf8"))) this.db.public.none(statement);
    for (const statement of sqlStatements(readFileSync(migrationPath("003_guidance_version.sql"), "utf8"))) this.db.public.none(statement);
    if (this.tableCount() !== TABLES.length) throw new Error(`migration must create ${TABLES.length} canonical tables`);
  }

  tableCount(): number {
    const rows = this.db.public.many("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'") as Array<{ table_name: string }>;
    return rows.filter((row) => (TABLES as readonly string[]).includes(row.table_name)).length;
  }

  tableNames(): string[] { return [...TABLES]; }
  rowCount(table: string): number {
    if (!(TABLES as readonly string[]).includes(table)) throw new Error("unknown table");
    const row = this.db.public.one(`SELECT count(*)::int AS count FROM ${table}`) as { count: number };
    return Number(row.count);
  }

  get persistedTransactionCount(): number { return this.lastTransactionTableCount; }
  loadState(): StoreState | null { return !this.filePath || !existsSync(this.filePath) ? null : decodeStoreState(readFileSync(this.filePath, "utf8")); }

  saveState(state: StoreState): void {
    const backup = this.db.backup();
    try {
      for (const statement of persistenceStatements(state)) this.db.public.none(statement);
      this.lastTransactionTableCount = this.tableCount();
    } catch (error) {
      backup.restore();
      throw error;
    }
    if (this.filePath) {
      const temporary = `${this.filePath}.tmp-${process.pid}`;
      writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
      renameSync(temporary, this.filePath);
    }
  }

  loadOAuthState(): OAuthState | null { return this.oauthState ? structuredClone(this.oauthState) : null; }
  saveOAuthState(state: OAuthState): void { this.oauthState = structuredClone(state); }
}

/** Real PostgreSQL adapter selected whenever DATABASE_URL is set. */
export class PostgresDatabase implements TrustLayerDatabase {
  private readonly pool: PostgresPool;
  private readonly ownsPool: boolean;
  private migrations: Promise<void> | undefined;

  constructor(options: { connectionString: string; pool?: PostgresPool }) {
    if (!options.connectionString.trim()) throw new Error("DATABASE_URL must not be empty");
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString });
    this.ownsPool = options.pool === undefined;
  }

  async loadState(): Promise<StoreState | null> {
    await this.ensureMigrations();
    const client = await this.pool.connect();
    try {
      const result = await client.query("SELECT state FROM trust_layer_runtime_state WHERE singleton = true");
      return result.rows.length === 1 && isRecord(result.rows[0]) ? decodeStoreState(result.rows[0].state) : null;
    } finally { client.release(); }
  }

  async saveState(state: StoreState): Promise<void> {
    await this.ensureMigrations();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const statement of persistenceStatements(state)) await client.query(statement);
      await client.query("INSERT INTO trust_layer_runtime_state (singleton, state, updated_at) VALUES (true, $1::jsonb, now()) ON CONFLICT (singleton) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at", [JSON.stringify(state)]);
      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original persistence failure */ }
      throw error;
    } finally { client.release(); }
  }

  async loadOAuthState(): Promise<OAuthState | null> {
    await this.ensureMigrations();
    const client = await this.pool.connect();
    try {
      const result = await client.query("SELECT state FROM trust_layer_oauth_runtime_state WHERE singleton = true");
      return result.rows.length === 1 && isRecord(result.rows[0]) ? decodeOAuthState(result.rows[0].state) : null;
    } finally { client.release(); }
  }

  async saveOAuthState(state: OAuthState): Promise<void> {
    await this.ensureMigrations();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO trust_layer_oauth_runtime_state (singleton, state, updated_at) VALUES (true, $1::jsonb, now()) ON CONFLICT (singleton) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at", [JSON.stringify(state)]);
      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original persistence failure */ }
      throw error;
    } finally { client.release(); }
  }

  async close(): Promise<void> { if (this.ownsPool) await this.pool.end(); }

  private ensureMigrations(): Promise<void> {
    this.migrations ??= this.applyMigrations();
    return this.migrations;
  }

  private async applyMigrations(): Promise<void> {
    const client = await this.pool.connect();
    try {
      for (const name of ["001_trust_layer.sql", "002_runtime_state.sql", "003_guidance_version.sql"] as const) {
        for (const statement of sqlStatements(readFileSync(migrationPath(name), "utf8"))) await client.query(statement);
      }
    } finally { client.release(); }
  }
}

export function createDatabaseFromEnvironment(environment: NodeJS.ProcessEnv = process.env): TrustLayerDatabase {
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (databaseUrl) return new PostgresDatabase({ connectionString: databaseUrl });
  if (environment.NODE_ENV === "production") throw new Error("DATABASE_URL must be set in production; pg-mem and state files are test/development-only");
  return new PostgresCompatDatabase({ filePath: environment.TRUST_LAYER_DB_FILE ?? null });
}

export { TABLES as TRUST_LAYER_TABLES };
