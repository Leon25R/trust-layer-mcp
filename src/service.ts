import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { SystemClock } from "./clock.js";
import { parseAllowedOrigins, requireSecret } from "./config.js";
import { createDatabaseFromEnvironment, PostgresCompatDatabase, type TrustLayerDatabase } from "./db.js";
import {
  buildPublicProjections,
  buildPublicStatsProjection,
  normalizePublicDomain,
  PublicLookupUnavailableError,
  PUBLIC_CONSENT_VERSION,
  PUBLIC_STATS_COVERAGE_STARTED_AT,
  PUBLIC_STATS_REFRESH_INTERVAL_MS,
  sanitizePublicStatsProjection,
  type PublicProjection,
  type PublicProjectionBuildInput,
  type PublicProjectionPublication,
  type PublicStatsObservation,
  type PublicStatsProjection,
  type PublicStatsProjectionBuildInput,
  type PublicStatsPublication,
  type PublicStatsProjectionPublisher,
  type PublicSignalNotice,
} from "./publicLookup.js";
import { SchemaCatalog, type ToolName } from "./schemaCatalog.js";
import type {
  Aggregate, AssessmentBatchInput, AssessmentInput, BatchAcceptedResult, BatchIdempotentResult,
  BatchItemResult, BatchRejectedResult, BatchSuccessResult, Clock, ErrorResult,
  Hold, InputUsage, LookupInput, ManifestInput, ModelFamily, ModelName, Participant, Receipt,
  PublicStatsLedger, ResearchManifest, Rollup, SourceDecision, StoreState, SuccessResult, ToolContext, ToolResult,
  Tombstone, VerificationInput,
} from "./types.js";

const DAY = 86_400_000;
const INPUT_SHORT = 10 * 60_000;
const INPUT_LONG = DAY;
const ASSESSMENT_SHORT = INPUT_SHORT;
const ASSESSMENT_LONG = DAY;
const MANIFEST_TTL = 14 * DAY;
const RECEIPT_TTL = 30 * DAY;
const ROLLUP_TTL = 97 * DAY;
const TOMBSTONE_TTL = 30 * DAY;

const POSITIVE_RULE_V03 = Object.freeze({
  // This is capped decisive mass, not the raw number of observations. Each
  // provenance group contributes at most 1.0 before this rule is evaluated.
  minCappedDecisiveMassAfterOmission: 10,
  minPosteriorMean: 0.70,
  minBetaTail: 0.90,
});

interface CappedDecisionMetrics {
  support: number;
  rejection: number;
  decisive: number;
  crossGroupFamilyDiversity: boolean;
}

type Outcome = AssessmentInput["outcome"];

export interface TrustLayerOptions {
  clock?: Clock;
  secret?: string;
  allowedOrigins?: string[];
  /** Stage 1 intentionally gates positive states; stage 2 enables them. */
  stage?: 1 | 2;
  catalog?: SchemaCatalog;
  database?: TrustLayerDatabase;
  dbFile?: string | null;
  /** Explicit operator notices only; ordinary observations never populate this map. */
  publicOperatorObservations?: ReadonlyMap<string, PublicSignalNotice>;
  /** A failed builder makes the public projection unavailable instead of empty. */
  publicProjectionBuilder?: (input: PublicProjectionBuildInput) => ReadonlyMap<string, PublicProjection>;
  /** A failed stats builder makes the aggregate-only stats snapshot unavailable. */
  publicStatsProjectionBuilder?: (input: PublicStatsProjectionBuildInput) => PublicStatsProjection;
}

export type PublicProjectionPublisher = (publication: PublicProjectionPublication) => void;

export interface IssuedSyntheticToken {
  token: string;
  participantId: string;
  inviteOriginGroup: string;
  issuedAt: string;
}

class ServiceError extends Error {
  constructor(public readonly code: ErrorResult["code"], public readonly retryAfterSeconds?: number, public readonly commit = false) {
    super(code);
    this.name = "ServiceError";
  }
}

type BatchClassification =
  | { itemIndex: number; kind: "valid"; input: AssessmentInput }
  | { itemIndex: number; kind: "invalid_schema" }
  | { itemIndex: number; kind: "duplicate" };

type AssessmentIdentity =
  | { kind: "new" }
  | { kind: "idempotent" }
  | { kind: "research_id_conflict" }
  | { kind: "batch_expired" };

interface DispatchOutcome {
  result: ToolResult;
  /** Batch only: applied after the outer success schema gate passes. */
  commitState?: StoreState;
  /** Batch only: input/invalid accounting retained if the outer success gate fails. */
  validationFailureState?: StoreState;
}

type AssessmentSuccess = {
  ok: true;
  code: "accepted" | "accepted_idempotent";
  receipt_id: string;
  remaining_24h: number;
  aggregate_effect: "eligible" | "deduplicated" | "pending_weight";
};

type BatchInvalidCooldown = {
  kind: "existing_active" | "started";
  retryAfterSeconds: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejected(
  itemIndex: number,
  errorCode: BatchRejectedResult["error_code"],
  retryDirective: BatchRejectedResult["retry_directive"],
  retryAfterSeconds?: number,
): BatchRejectedResult {
  return {
    item_index: itemIndex,
    status: "rejected",
    error_code: errorCode,
    retry_directive: retryDirective,
    ...(retryAfterSeconds === undefined ? {} : { retry_after_seconds: retryAfterSeconds }),
  };
}

function toAcceptedBatchResult(itemIndex: number, result: AssessmentSuccess): BatchAcceptedResult | BatchIdempotentResult {
  if (result.code === "accepted_idempotent") {
    return {
      item_index: itemIndex,
      status: "accepted_idempotent",
      receipt_id: result.receipt_id,
      aggregate_effect: result.aggregate_effect === "eligible" ? "eligible" : "deduplicated",
      rate_charge: "none_idempotent",
      remaining_24h_after_item: result.remaining_24h,
    };
  }
  return {
    item_index: itemIndex,
    status: "accepted",
    receipt_id: result.receipt_id,
    aggregate_effect: result.aggregate_effect,
    rate_charge: result.aggregate_effect === "deduplicated" ? "none_already_contributed" : "new_token_domain",
    remaining_24h_after_item: result.remaining_24h,
  };
}

function summarize(results: readonly BatchItemResult[]): Pick<BatchSuccessResult, "batch_outcome" | "processed_count" | "accepted_count" | "idempotent_count" | "rejected_count"> {
  const acceptedCount = results.filter((result) => result.status === "accepted").length;
  const idempotentCount = results.filter((result) => result.status === "accepted_idempotent").length;
  const rejectedCount = results.filter((result) => result.status === "rejected").length;
  return {
    batch_outcome: rejectedCount === 0 ? "all_accepted" : acceptedCount + idempotentCount === 0 ? "all_rejected" : "partial_success",
    processed_count: results.length,
    accepted_count: acceptedCount,
    idempotent_count: idempotentCount,
    rejected_count: rejectedCount,
  };
}

function batchResultInvariantsHold(results: readonly BatchItemResult[]): boolean {
  const summary = summarize(results);
  return results.length >= 1
    && results.length <= 5
    && results.every((result, index) => result.item_index === index)
    && summary.processed_count === results.length
    && summary.accepted_count + summary.idempotent_count + summary.rejected_count === summary.processed_count
    && summary.batch_outcome === (summary.rejected_count === 0
      ? "all_accepted"
      : summary.accepted_count + summary.idempotent_count === 0 ? "all_rejected" : "partial_success");
}

function toRejectedBatchResult(index: number, error: unknown, oneSlotInputRetryAfter: number | undefined): BatchRejectedResult {
  if (!(error instanceof ServiceError)) return rejected(index, "internal_error", "retry_same_research_id");
  switch (error.code) {
    case "research_id_conflict":
    case "batch_expired":
      return rejected(index, error.code, "do_not_retry_same_research_id");
    case "rate_limited":
      return rejected(index, "rate_limited", "retry_same_research_id_after_delay", Math.max(error.retryAfterSeconds ?? 600, oneSlotInputRetryAfter ?? 0));
    default:
      return rejected(index, "internal_error", "retry_same_research_id");
  }
}

function iso(ms: number): string { return new Date(ms).toISOString(); }
function nowMs(clock: Clock): number { return clock.now().getTime(); }
function b64(value: Buffer): string { return value.toString("base64url"); }
function id(prefix: string): string { return `${prefix}_${b64(randomBytes(24))}`; }

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function emptyState(): StoreState {
  return {
    publicStatsLedger: { coverageStartedAt: PUBLIC_STATS_COVERAGE_STARTED_AT, acceptedByDate: {} },
    participants: {}, sites: {}, aggregates: {}, rollups: {}, receipts: {}, manifests: {},
    sourceDecisions: {}, tombstones: {}, verifications: {}, holds: {}, inputUsage: {},
    assessmentUsage: {}, modelFamilyMap: {
      openai_gpt5: "openai", anthropic_claude4: "anthropic", google_gemini3: "google",
      local_fixed: "local", other_fixed: "other", unknown: "unknown",
    }, receiptByTokenDomain: {}, receiptByResearchId: {},
  };
}

function cloneState(state: StoreState): StoreState {
  return structuredClone(state) as StoreState;
}

function dateKey(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
function isWithin(ms: number, start: number, end: number): boolean { return ms >= start && ms <= end; }

export class TrustLayerService {
  readonly clock: Clock;
  readonly catalog: SchemaCatalog;
  readonly allowedOrigins: Set<string>;
  readonly stage: 1 | 2;
  readonly database: TrustLayerDatabase;
  private readonly secret: string;
  private state: StoreState = emptyState();
  private initialized = false;
  private tail: Promise<void> = Promise.resolve();
  private readonly publicOperatorObservations: ReadonlyMap<string, PublicSignalNotice>;
  private readonly publicProjectionBuilder?: TrustLayerOptions["publicProjectionBuilder"];
  private readonly publicStatsProjectionBuilder?: TrustLayerOptions["publicStatsProjectionBuilder"];
  private publicProjectionPublisher: PublicProjectionPublisher | undefined;
  private publicStatsProjectionPublisher: PublicStatsProjectionPublisher | undefined;
  private publicProjectionGenerationAttempted = false;
  private publicStatsProjectionGenerationAttempted = false;
  private lastPublicProjections = new Map<string, PublicProjection>();
  private lastStatsPublication: PublicStatsPublication | undefined;
  private lastDurableState: StoreState = emptyState();
  private persistenceFailed = false;
  private lastPublication: PublicProjectionPublication | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private maintenanceStopped = false;

  constructor(options: TrustLayerOptions = {}) {
    this.clock = options.clock ?? new SystemClock();
    this.catalog = options.catalog ?? new SchemaCatalog();
    this.secret = requireSecret("TRUST_LAYER_SECRET", options.secret ?? process.env.TRUST_LAYER_SECRET);
    this.allowedOrigins = new Set(options.allowedOrigins ?? (process.env.NODE_ENV === "test" ? ["http://localhost", "http://127.0.0.1"] : parseAllowedOrigins(process.env.TRUST_LAYER_ALLOWED_ORIGINS)));
    this.stage = options.stage ?? 2;
    this.publicOperatorObservations = new Map(options.publicOperatorObservations ?? []);
    this.publicProjectionBuilder = options.publicProjectionBuilder;
    this.publicStatsProjectionBuilder = options.publicStatsProjectionBuilder;
    this.database = options.database ?? (process.env.DATABASE_URL || process.env.NODE_ENV === "production"
      ? createDatabaseFromEnvironment()
      : new PostgresCompatDatabase({ filePath: options.dbFile ?? null }));
  }

  /** Issues a local-only token. It is returned once and never stored in plaintext. */
  async issueSyntheticToken(inviteOriginGroup = "synthetic-local", detailConsent = false): Promise<IssuedSyntheticToken> {
    return this.exclusive(async () => {
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(inviteOriginGroup)) throw new Error("invalid invite origin group");
      const issuedAt = iso(nowMs(this.clock));
      const token = `tl_${b64(randomBytes(32))}`;
      const participantId = randomUUID();
      const tokenHash = this.tokenHash(token);
      const participant: Participant = {
        participantId, tokenHash, inviteOriginGroup, issuedAt,
        matureAt: iso(new Date(issuedAt).getTime() + 7 * DAY), stoppedAt: null,
        detailConsent, contributionCount: 0,
      };
      this.state.participants[tokenHash] = participant;
      await this.persistAndPublish();
      return { token, participantId, inviteOriginGroup, issuedAt };
    });
  }

  async stopSyntheticToken(token: string): Promise<void> {
    await this.exclusive(async () => {
      const participant = this.state.participants[this.tokenHash(token.replace(/^Bearer\s+/i, ""))];
      if (participant) participant.stoppedAt = iso(nowMs(this.clock));
      await this.persistAndPublish();
    });
  }

  /**
   * Executes one MCP tool with auth, Origin, input-resource counters, and the
   * tool's own atomic transaction. Error text intentionally contains no Ajv
   * paths or request data.
   */
  async executeTool(tool: ToolName, input: unknown, context: ToolContext = {}): Promise<ToolResult> {
    return this.exclusive(async () => this.executeToolLocked(tool, input, context));
  }

  private async executeToolLocked(tool: ToolName, input: unknown, context: ToolContext): Promise<ToolResult> {
    const digest = this.requestDigest(input);
    const draft = cloneState(this.state);
    this.runTtl(draft);
    let operationBase: StoreState | undefined;
    try {
      if (context.origin !== undefined && !this.allowedOrigins.has(context.origin)) {
        throw new ServiceError("origin_not_allowed");
      }
      const participant = this.authenticate(draft, context);
      this.assertInputResource(draft, participant.tokenHash, this.inputUnits(tool, input));

      // Keep the public distinction for a sensitive manifest URL while the
      // independent request schema still rejects it as a schema violation.
      if (tool === "report_research_manifest" && this.hasSensitiveCanonicalUrl(input)) {
        this.markInvalid(draft, participant.tokenHash);
        this.state = draft;
        return this.error("forbidden_url_scope", digest);
      }
      if (tool === "report_research_manifest") {
        const urlError = this.earlyManifestUrlError(input);
        if (urlError) {
          this.markInvalid(draft, participant.tokenHash);
          this.state = draft;
          return this.error(urlError, digest);
        }
      }

      const validation = this.catalog.validateInput(tool, input);
      if (!validation.valid) {
        if (tool === "report_domain_assessments_batch") {
          const cooldown = this.noteInvalidBatchItems(
            draft,
            participant.tokenHash,
            this.invalidUnitsForOuterBatch(input),
          );
          const retryAfter = this.maxRetryAfter(
            cooldown?.retryAfterSeconds,
            this.inputResourceRetryAfter(draft, participant.tokenHash, this.invalidUnitsForOuterBatch(input)),
          );
          this.state = draft;
          return this.error(
            "invalid_schema",
            digest,
            retryAfter,
            retryAfter === undefined ? undefined : "fix_request_then_retry_after_delay",
          );
        }
        const invalidLimit = this.markInvalid(draft, participant.tokenHash);
        this.state = draft;
        return this.error(invalidLimit ?? "invalid_schema", digest);
      }
      operationBase = cloneState(draft);
      const outcome = this.dispatch(draft, tool, input as never, participant, digest);
      const result = outcome.result;
      if (!result.ok) {
        if (!this.catalog.validateError(result).valid) throw new Error("invalid internal error response");
        if (outcome.validationFailureState) draft.inputUsage = cloneState(outcome.validationFailureState).inputUsage;
        this.state = draft;
        return result;
      }
      const successValidation = this.catalog.validateSuccess(tool, result);
      if (!successValidation.valid) {
        if (outcome.validationFailureState) draft.inputUsage = cloneState(outcome.validationFailureState).inputUsage;
        this.state = draft;
        return this.error("internal_error", digest);
      }
      if (outcome.validationFailureState) draft.inputUsage = cloneState(outcome.validationFailureState).inputUsage;
      if (outcome.commitState) this.replaceState(draft, outcome.commitState);
      this.state = draft;
      return result;
    } catch (error) {
      if (operationBase && error instanceof ServiceError && !error.commit) {
        // Roll back tool writes while retaining the input-resource charge and
        // retention work from this request. This is the atomic boundary used
        // by final manifest rate-limit failures.
        operationBase.inputUsage = draft.inputUsage;
        operationBase.assessmentUsage = draft.assessmentUsage;
        this.state = operationBase;
      } else {
        this.state = draft; // input-resource and retention effects remain observable.
      }
      if (error instanceof ServiceError) {
        return this.error(error.code, digest, error.retryAfterSeconds);
      }
      return this.error("internal_error", digest);
    } finally {
      // The database commit is the publication boundary. A failed save rolls
      // back memory and makes all anonymous lookup unavailable.
      await this.persistAndPublish();
    }
  }

  /** Re-run TTL and aggregation jobs. Safe to invoke repeatedly at the same clock time. */
  async runRetention(): Promise<{ manifestsExpired: number; receiptsDeleted: number; rollupsDeleted: number; tombstonesDeleted: number }> {
    return this.exclusive(async () => {
      const draft = cloneState(this.state);
      this.ensurePublicStatsLedger(draft);
      const result = this.runTtl(draft);
      this.updatePublicStatsLedger(draft);
      this.state = draft;
      await this.persistAndPublish();
      this.refreshPublicStatsProjection();
      return result;
    });
  }

  /** Internal test/operator hook for injecting a non-personal hold. */
  async addHold(domain: string, holdState: Hold["holdState"], reason: string, expiresAt: string | null = null, publicApproved = false): Promise<void> {
    await this.exclusive(async () => {
      const draft = cloneState(this.state);
      domain = normalizePublicDomain(domain);
      const startedAt = iso(nowMs(this.clock));
      for (const [key, hold] of Object.entries(draft.holds)) if (hold.domain === domain && hold.reason === reason) delete draft.holds[key];
      const base = `${domain}|${reason}`;
      let key = base;
      for (let index = 1; draft.holds[key]; index++) key = `${base}|duplicate-${index}`;
      draft.holds[key] = { domain, holdState, reason, startedAt, expiresAt, releasedAt: null, publicApproved };
      if (!draft.sites[domain]) draft.sites[domain] = { domain, firstObservedAt: startedAt };
      this.recomputeDomain(draft, domain);
      this.state = draft;
      await this.persistAndPublish();
    });
  }

  async releaseHold(domain: string, reason: string): Promise<void> {
    await this.exclusive(async () => {
      const draft = cloneState(this.state);
      domain = normalizePublicDomain(domain);
      for (const hold of Object.values(draft.holds)) {
        if (hold.domain === domain && hold.reason === reason) hold.releasedAt = iso(nowMs(this.clock));
      }
      this.recomputeDomain(draft, domain);
      this.state = draft;
      await this.persistAndPublish();
    });
  }

  /** Returns only non-sensitive counters/aggregate data for deterministic tests. */
  snapshot(): { counts: Record<string, number>; aggregates: Record<string, Aggregate> } {
    return {
      counts: {
        participants: Object.keys(this.state.participants).length,
        receipts: Object.keys(this.state.receipts).length,
        manifests: Object.keys(this.state.manifests).length,
        sourceDecisions: Object.keys(this.state.sourceDecisions).length,
        tombstones: Object.keys(this.state.tombstones).length,
        rollups: Object.keys(this.state.rollups).length,
        verifications: Object.keys(this.state.verifications).length,
      },
      aggregates: structuredClone(this.state.aggregates) as Record<string, Aggregate>,
    };
  }

  async initialize(): Promise<void> {
    await this.exclusive(async () => {
      if (!this.publicProjectionGenerationAttempted) this.refreshPublicProjection();
      if (!this.publicStatsProjectionGenerationAttempted) this.refreshPublicStatsProjection(true);
      this.scheduleMaintenance();
    });
  }

  private scheduleMaintenance(): void {
    if (this.maintenanceStopped || this.refreshTimer) return;
    this.refreshTimer = setTimeout(async () => {
      try { await this.runRetention(); } catch { this.publishUnavailable(); }
      finally { this.refreshTimer = undefined; this.scheduleMaintenance(); }
    }, 20_000);
    this.refreshTimer.unref();
  }

  /** Called by the HTTP server on shutdown; no queued interval backlog. */
  stopMaintenance(): void {
    this.maintenanceStopped = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  /**
   * Internal operator API, never exposed through MCP or anonymous HTTP.
   * The operator must verify ownership, stable principal identity, explicit
   * versioned sharing consent and non-sensitive scope before invoking it.
   * It is not a substitute for a future authenticated consent UI/directory.
   */
  async recordPublicConsent(receiptId: string, principalId: string, consentVersion: string): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(principalId)
      || consentVersion !== PUBLIC_CONSENT_VERSION) throw new Error("invalid public consent");
    principalId = principalId.toLowerCase();
    await this.exclusive(async () => {
      const receipt = this.state.receipts[receiptId];
      const participant = receipt && this.state.participants[receipt.tokenHash];
      if (!receipt || !participant || participant.stoppedAt || receipt.publicEligible !== true
        || new Date(receipt.observedAt).getTime() <= nowMs(this.clock) - RECEIPT_TTL) throw new Error("ineligible public observation");
      normalizePublicDomain(receipt.domain);
      const bindings = this.state.publicPrincipalBindings ?? {};
      if (bindings[participant.participantId] && bindings[participant.participantId] !== principalId) throw new Error("principal binding conflict");
      const draft = cloneState(this.state);
      draft.publicPrincipalBindings = { ...bindings, [participant.participantId]: principalId };
      draft.publicConsents ??= {};
      const previousConsent = draft.publicConsents[receiptId];
      const now = iso(nowMs(this.clock));
      const coverageStart = Date.parse(`${PUBLIC_STATS_COVERAGE_STARTED_AT}T00:00:00Z`);
      const observedAt = Date.parse(receipt.observedAt);
      const previousConsentCovered = previousConsent?.statsEligible === true
        && Date.parse(previousConsent.consentedAt) >= coverageStart && observedAt >= coverageStart;
      const statsEligible = previousConsentCovered || (nowMs(this.clock) >= coverageStart && observedAt >= coverageStart);
      draft.publicConsents[receiptId] = {
        receiptId,
        principalId,
        consentVersion: PUBLIC_CONSENT_VERSION,
        consentedAt: previousConsentCovered ? previousConsent!.consentedAt : now,
        revokedAt: null,
        statsEligible,
        statsCounted: previousConsentCovered && previousConsent?.statsCounted === true,
      };
      this.ensurePublicStatsLedger(draft);
      this.updatePublicStatsLedger(draft);
      this.state = draft;
      await this.persistAndPublish();
    });
  }

  async revokePublicConsent(receiptId: string): Promise<void> {
    await this.exclusive(async () => {
      const draft = cloneState(this.state);
      const consent = draft.publicConsents?.[receiptId];
      if (consent) consent.revokedAt = iso(nowMs(this.clock));
      this.state = draft;
      await this.persistAndPublish();
    });
  }

  private async persistAndPublish(): Promise<void> {
    try {
      this.normalizeHolds(this.state);
      await this.database.saveState(this.state);
      this.lastDurableState = cloneState(this.state);
      this.persistenceFailed = false;
    } catch (error) {
      this.state = cloneState(this.lastDurableState);
      this.persistenceFailed = true;
      this.publishUnavailable();
      throw error;
    }
    this.refreshPublicProjection();
  }

  private normalizeHolds(state: StoreState): void {
    const normalized: StoreState["holds"] = {};
    for (const hold of Object.values(state.holds)) {
      const domain = normalizePublicDomain(hold.domain);
      const base = `${domain}|${hold.reason}`;
      let key = base;
      // Preserve each original hold's expiry and human approval. Merging
      // collisions could shorten a withdrawal or extend a public notice.
      for (let index = 1; normalized[key]; index++) key = `${base}|duplicate-${index}`;
      normalized[key] = { ...hold, domain };
      // Legacy raw-only holds may have only a raw sites FK in their snapshot.
      state.sites[domain] ??= { domain, firstObservedAt: hold.startedAt };
    }
    state.holds = normalized;
  }

  private publishUnavailable(): void {
    this.publicProjectionGenerationAttempted = true;
    this.publishPublicProjectionUnavailable();
    this.publishPublicStatsUnavailable();
  }

  private publishPublicProjectionUnavailable(): void {
    this.lastPublication = { available: false, generatedAt: nowMs(this.clock), projections: new Map(), invalidatedDomains: [...this.lastPublicProjections.keys()] };
    this.lastPublicProjections.clear();
    this.publicProjectionPublisher?.(this.lastPublication);
  }

  private publishPublicStatsUnavailable(): void {
    this.publicStatsProjectionGenerationAttempted = true;
    this.lastStatsPublication = { available: false, generatedAt: nowMs(this.clock) };
    this.publicStatsProjectionPublisher?.(this.lastStatsPublication);
  }

  /** Connects the writer's immutable projection publication to anonymous lookup. */
  attachPublicProjectionPublisher(publisher: PublicProjectionPublisher): void {
    this.publicProjectionPublisher = publisher;
    // Replay only a committed publication, never an in-flight writer state.
    if (this.lastPublication) publisher(this.lastPublication);
    else publisher({ available: false, generatedAt: nowMs(this.clock), projections: new Map(), invalidatedDomains: [] });
  }

  /** Connects the aggregate-only published stats snapshot to anonymous HTTP. */
  attachPublicStatsProjectionPublisher(publisher: PublicStatsProjectionPublisher): void {
    this.publicStatsProjectionPublisher = publisher;
    if (this.lastStatsPublication) publisher(this.lastStatsPublication);
    else publisher({ available: false, generatedAt: nowMs(this.clock) });
  }

  private refreshPublicProjection(): void {
    if (this.persistenceFailed) { this.publishUnavailable(); return; }
    this.publicProjectionGenerationAttempted = true;
    const generatedAt = nowMs(this.clock);
    try {
      const { input } = this.publicProjectionBuildInput(generatedAt);
      const projections = new Map(this.publicProjectionBuilder?.(input) ?? buildPublicProjections(input));
      const invalidatedDomains = this.changedPublicProjectionDomains(this.lastPublicProjections, projections);
      this.lastPublicProjections = new Map(projections);
      this.lastPublication = { available: true, generatedAt, projections, invalidatedDomains };
      this.publicProjectionPublisher?.(this.lastPublication);
    } catch {
      this.publishUnavailable();
    }
  }

  private ensurePublicStatsLedger(state: StoreState): PublicStatsLedger {
    state.publicStatsLedger ??= { coverageStartedAt: PUBLIC_STATS_COVERAGE_STARTED_AT, acceptedByDate: {} };
    return state.publicStatsLedger;
  }

  /** Count each newly eligible consent once, without putting identifiers in the ledger. */
  private updatePublicStatsLedger(state: StoreState): void {
    const ledger = this.ensurePublicStatsLedger(state);
    const now = nowMs(this.clock);
    const today = dateKey(now);
    const coverageStart = Date.parse(`${ledger.coverageStartedAt}T00:00:00Z`);
    if (!Number.isFinite(coverageStart) || ledger.coverageStartedAt !== PUBLIC_STATS_COVERAGE_STARTED_AT
      || !ledger.acceptedByDate || typeof ledger.acceptedByDate !== "object") throw new Error("invalid public stats ledger");
    for (const consent of Object.values(state.publicConsents ?? {})) {
      if (consent.statsEligible !== true || consent.statsCounted === true || consent.revokedAt !== null) continue;
      const receipt = state.receipts[consent.receiptId];
      const participant = receipt && state.participants[receipt.tokenHash];
      const observedAt = receipt ? Date.parse(receipt.observedAt) : Number.NaN;
      const consentedAt = Date.parse(consent.consentedAt);
      if (!receipt || receipt.publicEligible !== true || !participant || participant.stoppedAt
        || consent.consentVersion !== PUBLIC_CONSENT_VERSION || state.publicPrincipalBindings?.[participant.participantId] !== consent.principalId
        || !Number.isFinite(observedAt) || !Number.isFinite(consentedAt) || observedAt <= now - RECEIPT_TTL
        || receipt.observedAt.slice(0, 10) >= today || consent.consentedAt.slice(0, 10) >= today
        || observedAt < coverageStart || consentedAt < coverageStart) continue;
      const date = consent.consentedAt.slice(0, 10);
      const current = ledger.acceptedByDate[date] ?? 0;
      if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) throw new Error("invalid public stats ledger");
      ledger.acceptedByDate[date] = current + 1;
      consent.statsCounted = true;
    }
  }

  private refreshPublicStatsProjection(force = false): void {
    this.publicStatsProjectionGenerationAttempted = true;
    if (this.persistenceFailed) { this.publishUnavailable(); return; }
    const generatedAt = Math.floor(nowMs(this.clock) / PUBLIC_STATS_REFRESH_INTERVAL_MS) * PUBLIC_STATS_REFRESH_INTERVAL_MS;
    if (!force && this.lastStatsPublication?.available && this.lastStatsPublication.generatedAt >= generatedAt) return;
    if (!this.lastPublication?.available) { this.publishPublicStatsUnavailable(); return; }
    try {
      // Reading stats must not materialize a ledger in a legacy state. The
      // ledger is created only by a writer such as consent or retention.
      const ledger = this.state.publicStatsLedger ?? {
        coverageStartedAt: PUBLIC_STATS_COVERAGE_STARTED_AT,
        acceptedByDate: {},
      };
      const { statsObservations } = this.publicProjectionBuildInput(generatedAt);
      const input: PublicStatsProjectionBuildInput = {
        generatedAt,
        coverageStartedAt: ledger.coverageStartedAt,
        acceptedByDate: ledger.acceptedByDate,
        observations: statsObservations,
      };
      const projection = sanitizePublicStatsProjection(this.publicStatsProjectionBuilder?.(input) ?? buildPublicStatsProjection(input));
      this.lastStatsPublication = { available: true, generatedAt, projection };
      this.publicStatsProjectionPublisher?.(this.lastStatsPublication);
    } catch {
      // Stats is an aggregate-only extension. A bad stats builder must not
      // erase the already published domain-signal projection.
      this.publishPublicStatsUnavailable();
    }
  }

  private publicProjectionBuildInput(generatedAt: number): { input: PublicProjectionBuildInput; statsObservations: PublicStatsObservation[] } {
    const statsObservations: PublicStatsObservation[] = [];
    const observations = Object.values(this.state.publicConsents ?? {}).flatMap((consent) => {
      const receipt = this.state.receipts[consent.receiptId];
      const participant = receipt && this.state.participants[receipt.tokenHash];
      const today = dateKey(generatedAt);
      if (!receipt || receipt.publicEligible !== true || !participant || participant.stoppedAt
        || consent.revokedAt !== null || consent.consentVersion !== PUBLIC_CONSENT_VERSION
        || this.state.publicPrincipalBindings?.[participant.participantId] !== consent.principalId
        || Date.parse(receipt.observedAt) <= generatedAt - RECEIPT_TTL
        || !(receipt.observedAt.slice(0, 10) < today) || !(consent.consentedAt.slice(0, 10) < today)) return [];
      // Legacy public consents may still serve the existing domain-signal
      // projection, but they must never be backfilled into stats coverage.
      if (consent.statsEligible === true) {
        const coverageStart = Date.parse(`${PUBLIC_STATS_COVERAGE_STARTED_AT}T00:00:00Z`);
        const observedAt = Date.parse(receipt.observedAt);
        const consentedAt = Date.parse(consent.consentedAt);
        if (Number.isFinite(coverageStart) && Number.isFinite(observedAt) && Number.isFinite(consentedAt)
          && observedAt >= coverageStart && consentedAt >= coverageStart
          && observedAt <= generatedAt && consentedAt <= generatedAt) {
          statsObservations.push({ domain: receipt.domain, principalId: consent.principalId, provenanceGroupHash: receipt.provenanceGroupHash, consentedAt: consent.consentedAt, observedAt: receipt.observedAt });
        }
      }
      return [{
        domain: receipt.domain,
        principalId: consent.principalId,
        consentVersion: consent.consentVersion,
        observedDate: receipt.observedAt.slice(0, 10),
        provenanceGroupHash: receipt.provenanceGroupHash,
        observedAt: receipt.observedAt,
      }];
    });
    return {
      input: {
        aggregates: this.state.aggregates,
        observations,
        rollups: Object.values(this.state.rollups).map((rollup) => ({
          domain: rollup.domain,
          provenanceGroupHash: rollup.provenanceGroupHash,
          observedDate: rollup.observedDate,
          lastObservedAt: rollup.lastObservedAt,
        })),
        holds: Object.values(this.state.holds).map((hold) => ({
          domain: hold.domain,
          holdState: hold.holdState,
          publicApproved: hold.publicApproved === true,
          active: hold.releasedAt === null && (hold.expiresAt === null || new Date(hold.expiresAt).getTime() > generatedAt),
        })),
        operatorObservations: this.publicOperatorObservations,
      },
      statsObservations,
    };
  }

  private changedPublicProjectionDomains(
    before: ReadonlyMap<string, PublicProjection>,
    after: ReadonlyMap<string, PublicProjection>,
  ): string[] {
    const domains = new Set([...before.keys(), ...after.keys()]);
    return [...domains].filter((domain) => JSON.stringify(before.get(domain) ?? null) !== JSON.stringify(after.get(domain) ?? null));
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: (() => void) | undefined;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (!this.initialized) {
        try {
          this.state = await this.database.loadState() ?? emptyState();
          this.lastDurableState = cloneState(this.state);
          const oldHolds = JSON.stringify(this.state.holds);
          this.normalizeHolds(this.state);
          // Do not initialize or persist the stats ledger while merely loading
          // state for an anonymous read. Legacy ledger migration belongs to a
          // write boundary (consent/retention).
          if (JSON.stringify(this.state.holds) !== oldHolds) await this.persistAndPublish();
          this.initialized = true;
        } catch {
          this.publishUnavailable();
          throw new PublicLookupUnavailableError();
        }
      }
      return await operation();
    } finally {
      release?.();
    }
  }

  private dispatch(
    state: StoreState,
    tool: ToolName,
    input: AssessmentInput | AssessmentBatchInput | ManifestInput | VerificationInput | LookupInput,
    participant: Participant,
    digest: string,
  ): DispatchOutcome {
    switch (tool) {
      case "report_domain_assessment": return { result: this.reportAssessment(state, input as AssessmentInput, participant, digest) };
      case "report_domain_assessments_batch": return this.reportAssessmentBatch(state, input as AssessmentBatchInput, participant, digest);
      case "report_research_manifest": return { result: this.reportManifest(state, input as ManifestInput, participant, digest) };
      case "submit_local_verification": return { result: this.submitVerification(state, input as VerificationInput, participant, digest) };
      case "lookup_domain_signal": return { result: this.lookup(state, input as LookupInput) };
    }
  }

  private preflightAssessmentIdentity(state: StoreState, input: AssessmentInput, participant: Participant, digest: string): AssessmentIdentity {
    const tombstone = state.tombstones[this.researchIdHmac(input.research_id)];
    if (tombstone) return { kind: tombstone.state === "expired" ? "batch_expired" : "research_id_conflict" };
    if (state.manifests[input.research_id]) return { kind: "research_id_conflict" };
    const existingByResearch = state.receiptByResearchId[input.research_id];
    if (!existingByResearch) return { kind: "new" };
    const existing = state.receipts[existingByResearch];
    return existing && existing.payloadDigest === digest && existing.tokenHash === participant.tokenHash
      ? { kind: "idempotent" }
      : { kind: "research_id_conflict" };
  }

  private reportAssessment(state: StoreState, input: AssessmentInput, participant: Participant, digest: string): AssessmentSuccess {
    const identity = this.preflightAssessmentIdentity(state, input, participant, digest);
    if (identity.kind === "batch_expired" || identity.kind === "research_id_conflict") throw new ServiceError(identity.kind);
    if (identity.kind === "idempotent") {
      const existing = state.receipts[state.receiptByResearchId[input.research_id]];
      if (!existing) throw new ServiceError("research_id_conflict");
      return { ok: true, code: "accepted_idempotent", receipt_id: existing.receiptId, remaining_24h: this.remainingAssessment(state, participant.tokenHash), aggregate_effect: existing.appliedWeight > 0 ? "eligible" : "deduplicated" };
    }
    const key = this.tokenDomainKey(participant.tokenHash, input.domain, input.rubric_version);
    const alreadyContributed = Boolean(state.receiptByTokenDomain[key]);
    if (!alreadyContributed) this.assertAssessmentRate(state, participant.tokenHash);
    const receipt = this.recordAssessment(state, input, participant, digest, alreadyContributed, "minimal");
    return { ok: true, code: "accepted", receipt_id: receipt.receiptId, remaining_24h: this.remainingAssessment(state, participant.tokenHash), aggregate_effect: alreadyContributed ? "deduplicated" : (receipt.appliedWeight < 1 ? "pending_weight" : "eligible") };
  }

  private isValidBatchAssessment(candidate: unknown): candidate is AssessmentInput {
    return this.catalog.validateInput("report_domain_assessment", candidate).valid;
  }

  private duplicateResearchIdIndexes(entries: readonly { itemIndex: number; input: AssessmentInput }[]): Set<number> {
    const indexesByResearchId = new Map<string, number[]>();
    for (const entry of entries) {
      const indexes = indexesByResearchId.get(entry.input.research_id) ?? [];
      indexes.push(entry.itemIndex);
      indexesByResearchId.set(entry.input.research_id, indexes);
    }
    return new Set([...indexesByResearchId.values()].filter((indexes) => indexes.length > 1).flat());
  }

  private assertCommittableBatchItem(item: BatchAcceptedResult | BatchIdempotentResult): void {
    const probe: BatchSuccessResult = {
      ok: true,
      code: "batch_processed",
      ...summarize([item]),
      remaining_24h: item.remaining_24h_after_item,
      results: [item],
    };
    if (!this.catalog.validateSuccess("report_domain_assessments_batch", probe).valid) throw new Error("invalid batch item result");
  }

  private reportAssessmentBatch(
    state: StoreState,
    input: AssessmentBatchInput,
    authenticatedParticipant: Participant,
    batchDigest: string,
  ): DispatchOutcome {
    const classified: BatchClassification[] = input.assessments.map((candidate, itemIndex) =>
      this.isValidBatchAssessment(candidate)
        ? { itemIndex, kind: "valid" as const, input: candidate }
        : { itemIndex, kind: "invalid_schema" as const },
    );
    const validBeforeDuplicate = classified.filter(
      (entry): entry is Extract<BatchClassification, { kind: "valid" }> => entry.kind === "valid",
    );
    for (const itemIndex of this.duplicateResearchIdIndexes(validBeforeDuplicate)) classified[itemIndex] = { itemIndex, kind: "duplicate" };

    const validEntries = classified.filter(
      (entry): entry is Extract<BatchClassification, { kind: "valid" }> => entry.kind === "valid",
    );
    const identities = new Map<number, AssessmentIdentity>();
    for (const entry of validEntries) {
      identities.set(entry.itemIndex, this.preflightAssessmentIdentity(state, entry.input, authenticatedParticipant, this.requestDigest(entry.input)));
    }

    const invalidCount = classified.filter((entry) => entry.kind !== "valid").length;
    const nonBusinessDraft = cloneState(state);
    const cooldown = invalidCount === 0
      ? undefined
      : this.noteInvalidBatchItems(nonBusinessDraft, authenticatedParticipant.tokenHash, invalidCount);
    const oneSlotRetryAfter = this.inputResourceRetryAfter(nonBusinessDraft, authenticatedParticipant.tokenHash, 1);
    const batchDraft = cloneState(nonBusinessDraft);
    const results: BatchItemResult[] = [];

    for (const entry of classified) {
      if (entry.kind === "invalid_schema") {
        const retryAfter = this.maxRetryAfter(cooldown?.retryAfterSeconds, oneSlotRetryAfter);
        results.push(retryAfter === undefined
          ? rejected(entry.itemIndex, "invalid_schema", "fix_input_then_retry")
          : rejected(entry.itemIndex, "invalid_schema", "fix_input_then_retry_after_delay", retryAfter));
        continue;
      }
      if (entry.kind === "duplicate") {
        const retryAfter = this.maxRetryAfter(cooldown?.retryAfterSeconds, oneSlotRetryAfter);
        results.push(retryAfter === undefined
          ? rejected(entry.itemIndex, "duplicate_research_id_in_batch", "remove_duplicate_then_retry")
          : rejected(entry.itemIndex, "duplicate_research_id_in_batch", "remove_duplicate_then_retry_after_delay", retryAfter));
        continue;
      }

      const identity = identities.get(entry.itemIndex);
      if (!identity) {
        results.push(rejected(entry.itemIndex, "internal_error", "retry_same_research_id"));
        continue;
      }
      if (identity.kind === "research_id_conflict" || identity.kind === "batch_expired") {
        results.push(rejected(entry.itemIndex, identity.kind, "do_not_retry_same_research_id"));
        continue;
      }
      if (identity.kind === "new" && cooldown !== undefined) {
        const retryAfter = this.maxRetryAfter(cooldown.retryAfterSeconds, oneSlotRetryAfter);
        results.push(rejected(entry.itemIndex, "rate_limited", "retry_same_research_id_after_delay", retryAfter ?? 600));
        continue;
      }

      const itemDraft = cloneState(batchDraft);
      const itemParticipant = itemDraft.participants[authenticatedParticipant.tokenHash];
      if (!itemParticipant) {
        results.push(rejected(entry.itemIndex, "internal_error", "retry_same_research_id"));
        continue;
      }
      const itemDigest = this.requestDigest(entry.input);
      try {
        const accepted = this.reportAssessment(itemDraft, entry.input, itemParticipant, itemDigest);
        const itemResult = toAcceptedBatchResult(entry.itemIndex, accepted);
        this.assertCommittableBatchItem(itemResult);
        this.replaceState(batchDraft, itemDraft);
        results.push(itemResult);
      } catch (error) {
        results.push(toRejectedBatchResult(entry.itemIndex, error, oneSlotRetryAfter));
      }
    }

    if (!batchResultInvariantsHold(results)) return { result: this.error("internal_error", batchDigest), validationFailureState: nonBusinessDraft };
    const result: BatchSuccessResult = {
      ok: true,
      code: "batch_processed",
      ...summarize(results),
      remaining_24h: this.remainingAssessment(batchDraft, authenticatedParticipant.tokenHash),
      results,
    };
    if (!this.catalog.validateSuccess("report_domain_assessments_batch", result).valid) {
      return { result: this.error("internal_error", batchDigest), validationFailureState: nonBusinessDraft };
    }
    return { result, commitState: batchDraft, validationFailureState: nonBusinessDraft };
  }

  private reportManifest(state: StoreState, input: ManifestInput, participant: Participant, digest: string): SuccessResult {
    const idForResearch = this.researchIdHmac(input.research_id);
    const tombstone = state.tombstones[idForResearch];
    if (tombstone) {
      if (tombstone.state === "expired") throw new ServiceError("batch_expired");
      throw new ServiceError("research_id_conflict");
    }
    if (!state.manifests[input.research_id] && state.receiptByResearchId[input.research_id]) throw new ServiceError("research_id_conflict");
    const batch = input.manifest;
    if (batch.batch_index > batch.batch_count || batch.complete !== (batch.batch_index === batch.batch_count)) {
      this.rejectManifest(state, input.research_id, "rejected");
      throw new ServiceError("batch_incomplete", undefined, true);
    }
    this.validateSourceSafety(input);

    let parent = state.manifests[input.research_id];
    if (parent) {
      if (parent.tokenHash !== participant.tokenHash || parent.rubricVersion !== input.rubric_version || parent.guidanceVersion !== input.guidance_version || parent.batchCount !== batch.batch_count || parent.sourceCountTotal !== batch.source_count_total || parent.collectionMode !== input.collection_mode || stableStringify(parent.questionContext) !== stableStringify(input.question_context)) {
        throw new ServiceError("research_id_conflict");
      }
      const oldBatch = parent.batches[String(batch.batch_index)];
      if (oldBatch) {
        if (oldBatch.digest === digest) return { ok: true, code: "accepted_idempotent", manifest_receipt_id: parent.manifestReceiptId, batch_status: parent.state === "complete_eligible" ? "complete_eligible" : "awaiting_batches", rate_charge: "none", remaining_24h: this.remainingAssessment(state, participant.tokenHash) };
        throw new ServiceError("research_id_conflict");
      }
      if (parent.state === "complete_eligible" || parent.state === "rejected" || parent.state === "expired") throw new ServiceError("research_id_conflict");
    } else {
      parent = {
        researchId: input.research_id, tokenHash: participant.tokenHash, rubricVersion: input.rubric_version,
        guidanceVersion: input.guidance_version,
        collectionMode: input.collection_mode, agentModelName: input.agent_model_name,
        questionContext: structuredClone(input.question_context), sourceCountTotal: batch.source_count_total,
        batchCount: batch.batch_count, firstAcceptedAt: iso(nowMs(this.clock)), state: "open", batches: {},
        manifestReceiptId: id("m"),
      };
      state.manifests[input.research_id] = parent;
    }

    const sourceRefs = batch.sources.map((source) => source.source_ref);
    if (new Set(sourceRefs).size !== sourceRefs.length || Object.values(parent.batches).some((old) => old.sourceRefs.some((ref) => sourceRefs.includes(ref)))) {
      this.rejectManifest(state, input.research_id, "rejected");
      throw new ServiceError("batch_incomplete", undefined, true);
    }
    const manifestBatch = { digest, index: batch.batch_index, complete: batch.complete, sourceRefs, payload: structuredClone(batch) };
    parent.batches[String(batch.batch_index)] = manifestBatch;
    for (const source of batch.sources) {
      const decision: SourceDecision = { ...structuredClone(source), researchId: input.research_id };
      state.sourceDecisions[`${input.research_id}|${source.source_ref}`] = decision;
    }

    if (!batch.complete) {
      parent.state = "awaiting_batches";
      return { ok: true, code: "accepted", manifest_receipt_id: parent.manifestReceiptId, batch_status: "awaiting_batches", rate_charge: "none", remaining_24h: this.remainingAssessment(state, participant.tokenHash) };
    }
    const batches = Object.values(parent.batches).sort((left, right) => left.index - right.index);
    const expected = Array.from({ length: parent.batchCount }, (_, index) => index + 1);
    if (batches.length !== parent.batchCount || batches.some((entry, index) => entry.index !== expected[index]) || batches.reduce((sum, entry) => sum + entry.sourceRefs.length, 0) !== parent.sourceCountTotal || !batch.final_assessment) {
      this.rejectManifest(state, input.research_id, "rejected");
      throw new ServiceError("batch_incomplete", undefined, true);
    }
    const allSources = batches.flatMap((entry) => entry.payload.sources);
    const allRefs = allSources.map((source) => source.source_ref);
    if (new Set(allRefs).size !== allRefs.length || allSources.some((source) => source.domain !== batch.final_assessment!.domain) || batch.final_assessment.domain !== allSources[0]?.domain || batch.final_assessment.domain === "") {
      this.rejectManifest(state, input.research_id, "rejected");
      throw new ServiceError("batch_incomplete", undefined, true);
    }
    const refsSet = new Set(allRefs);
    if (allSources.some((source) => source.related_source_refs.some((ref) => !refsSet.has(ref)))) {
      this.rejectManifest(state, input.research_id, "rejected");
      throw new ServiceError("invalid_reference", undefined, true);
    }
    const finalAssessment = batch.final_assessment;
    if (state.receiptByResearchId[input.research_id]) throw new ServiceError("research_id_conflict");
    const tokenDomainKey = this.tokenDomainKey(participant.tokenHash, finalAssessment.domain, input.rubric_version);
    const alreadyContributed = Boolean(state.receiptByTokenDomain[tokenDomainKey]);
    if (!alreadyContributed) this.assertAssessmentRate(state, participant.tokenHash);
    parent.finalAssessment = structuredClone(finalAssessment);
    parent.state = "complete_eligible";
    const receiptInput: AssessmentInput = { research_id: input.research_id, collection_mode: "minimal_observation", rubric_version: input.rubric_version, guidance_version: parent.guidanceVersion, domain: finalAssessment.domain, outcome: finalAssessment.outcome, reason_code: finalAssessment.reason_code, agent_model_name: input.agent_model_name };
    this.recordAssessment(state, receiptInput, participant, digest, alreadyContributed, "manifest");
    return { ok: true, code: "accepted", manifest_receipt_id: parent.manifestReceiptId, batch_status: "complete_eligible", rate_charge: alreadyContributed ? "none" : "new_final_assessment", remaining_24h: this.remainingAssessment(state, participant.tokenHash) };
  }

  private submitVerification(state: StoreState, input: VerificationInput, participant: Participant, digest: string): SuccessResult {
    const parent = state.manifests[input.research_id];
    if (!parent || parent.state !== "complete_eligible") throw new ServiceError("invalid_reference");
    if (parent.tokenHash !== participant.tokenHash) throw new ServiceError("not_authorized");
    const sourceKeys = Object.keys(state.sourceDecisions).filter((key) => key.startsWith(`${input.research_id}|`));
    const availableRefs = new Set(sourceKeys.map((key) => key.slice(input.research_id.length + 1)));
    if (input.checked_source_refs.some((ref) => !availableRefs.has(ref)) || input.alternative_source_refs.some((ref) => !availableRefs.has(ref))) throw new ServiceError("invalid_reference");
    const key = `${participant.tokenHash}|${input.research_id}`;
    const existing = state.verifications[key];
    if (existing) {
      if (existing.digest === digest) return { ok: true, code: "accepted_idempotent", attestation_id: existing.attestationId, verification_effect: "self_report_recorded_no_weight" };
      throw new ServiceError("research_id_conflict");
    }
    const attestationId = id("v");
    state.verifications[key] = { attestationId, researchId: input.research_id, tokenHash: participant.tokenHash, checkedSourceRefs: [...input.checked_source_refs], result: input.result, digest, completedAt: iso(nowMs(this.clock)) };
    return { ok: true, code: "accepted", attestation_id: attestationId, verification_effect: "self_report_recorded_no_weight" };
  }

  private lookup(state: StoreState, input: LookupInput): SuccessResult {
    if (!state.sites[input.domain]) throw new ServiceError("not_found");
    const aggregate = state.aggregates[input.domain] ?? this.recomputeDomain(state, input.domain);
    const now = nowMs(this.clock);
    const cautions: string[] = ["not_truth_claim"];
    if (aggregate.modelDiversity === "unconfirmed") cautions.push("model_diversity_unconfirmed");
    if (aggregate.state === "review_hold") cautions.push("review_hold_do_not_rely");
    if (aggregate.state === "withdrawn") cautions.push("withdrawn_do_not_rely");
    if (aggregate.verificationCoverage === "source_hygiene_spot_checked") cautions.push("source_hygiene_only");
    if (aggregate.state === "insufficient" || aggregate.state === "mixed_observations") cautions.push("additional_primary_check_recommended");
    const decisive = aggregate.decisive;
    return {
      ok: true, domain: input.domain, state: aggregate.state, state_reason: aggregate.stateReason,
      aggregate_window: { kind: "rolling", days: 90, window_start: iso(now - 90 * DAY) },
      last_observed_at: aggregate.lastObservedAt, last_evaluated_at: aggregate.lastEvaluatedAt,
      decisive_observation_band: decisive === 0 ? "0" : decisive <= 2 ? "1-2" : decisive <= 7 ? "3-7" : decisive <= 9 ? "8-9" : "10+",
      mixedness: this.mixedness(aggregate.support, aggregate.rejection), evidence_coverage: aggregate.evidenceCoverage,
      verification_coverage: aggregate.verificationCoverage, model_diversity: aggregate.modelDiversity,
      cautions: [...new Set(cautions)].slice(0, 5),
    };
  }

  private recordAssessment(state: StoreState, input: AssessmentInput, participant: Participant, digest: string, alreadyContributed: boolean, mode: "minimal" | "manifest"): Receipt {
    const now = iso(nowMs(this.clock));
    const modelFamily = state.modelFamilyMap[input.agent_model_name] ?? "unknown";
    const appliedWeight = alreadyContributed ? 0 : this.weightFor(participant, state, nowMs(this.clock));
    const receipt: Receipt = {
      receiptId: id("r"), researchId: input.research_id, domain: input.domain, outcome: input.outcome,
      reasonCode: input.reason_code, rubricVersion: input.rubric_version, guidanceVersion: input.guidance_version, tokenHash: participant.tokenHash,
      provenanceGroupHash: this.groupHash(participant.inviteOriginGroup), modelName: input.agent_model_name,
      modelFamily, appliedWeight, observedAt: now, payloadDigest: digest,
      publicEligible: mode === "minimal",
    };
    state.receipts[receipt.receiptId] = receipt;
    state.receiptByResearchId[input.research_id] = receipt.receiptId;
    if (!alreadyContributed) {
      state.receiptByTokenDomain[this.tokenDomainKey(participant.tokenHash, input.domain, input.rubric_version)] = receipt.receiptId;
      state.assessmentUsage[participant.tokenHash] = [...(state.assessmentUsage[participant.tokenHash] ?? []), now];
      participant.contributionCount += 1;
      if (appliedWeight > 0) this.addRollup(state, receipt, mode);
    }
    if (!state.sites[input.domain]) state.sites[input.domain] = { domain: input.domain, firstObservedAt: now };
    this.recomputeDomain(state, input.domain);
    return receipt;
  }

  private addRollup(state: StoreState, receipt: Receipt, mode: "minimal" | "manifest"): void {
    const key = `${receipt.domain}|${dateKey(new Date(receipt.observedAt).getTime())}|${receipt.provenanceGroupHash}|${receipt.modelFamily}`;
    const rollup: Rollup = state.rollups[key] ?? { key, domain: receipt.domain, observedDate: dateKey(new Date(receipt.observedAt).getTime()), lastObservedAt: receipt.observedAt, provenanceGroupHash: receipt.provenanceGroupHash, modelFamily: receipt.modelFamily, support: 0, rejection: 0, insufficient: 0, minimalCount: 0, manifestCount: 0 };
    rollup.lastObservedAt = receipt.observedAt > rollup.lastObservedAt ? receipt.observedAt : rollup.lastObservedAt;
    if (receipt.outcome === "used_as_support") rollup.support += receipt.appliedWeight;
    else if (receipt.outcome === "rejected_or_conflicted") rollup.rejection += receipt.appliedWeight;
    else rollup.insufficient += receipt.appliedWeight;
    if (mode === "minimal") rollup.minimalCount += 1; else rollup.manifestCount += 1;
    state.rollups[key] = rollup;
  }

  private recomputeDomain(state: StoreState, domain: string): Aggregate {
    const now = nowMs(this.clock);
    const start = now - 90 * DAY;
    const rollups = Object.values(state.rollups).filter((rollup) => rollup.domain === domain && isWithin(new Date(rollup.lastObservedAt).getTime(), start, now));
    const groups = new Map<string, { support: number; rejection: number; insufficient: number; families: Set<ModelFamily>; minimal: number; manifest: number; last: string }>();
    for (const rollup of rollups) {
      const group = groups.get(rollup.provenanceGroupHash) ?? { support: 0, rejection: 0, insufficient: 0, families: new Set<ModelFamily>(), minimal: 0, manifest: 0, last: rollup.lastObservedAt };
      group.support += rollup.support; group.rejection += rollup.rejection; group.insufficient += rollup.insufficient;
      if (rollup.support > 0 && rollup.modelFamily !== "unknown") group.families.add(rollup.modelFamily);
      group.minimal += rollup.minimalCount; group.manifest += rollup.manifestCount;
      if (rollup.lastObservedAt > group.last) group.last = rollup.lastObservedAt;
      groups.set(rollup.provenanceGroupHash, group);
    }
    let support = 0, rejection = 0, insufficient = 0;
    const supportFamilies = new Set<ModelFamily>();
    let maxGroup = 0, supportGroups = 0, rejectionGroups = 0, lastObservedAt: string | null = null;
    for (const group of groups.values()) {
      const total = group.support + group.rejection + group.insufficient;
      if (total <= 0) continue;
      const cap = Math.min(1, total);
      const factor = cap / total;
      const s = group.support * factor, r = group.rejection * factor, u = group.insufficient * factor;
      support += s; rejection += r; insufficient += u; maxGroup = Math.max(maxGroup, (group.support + group.rejection) * factor);
      if (s > 0) { supportGroups += 1; for (const family of group.families) supportFamilies.add(family); }
      if (r > 0) rejectionGroups += 1;
      if (lastObservedAt === null || group.last > lastObservedAt) lastObservedAt = group.last;
    }
    const decisive = support + rejection;
    const groupCount = [...groups.values()].filter((group) => group.support + group.rejection > 0).length;
    const crossGroupFamilyDiversity = this.hasCrossGroupFamilyDiversity(groups);
    const families = new Set<ModelFamily>();
    for (const group of groups.values()) for (const family of group.families) families.add(family);
    const D = decisive;
    const supportBase = this.meetsPositiveRule({
      support,
      rejection,
      decisive: D,
      crossGroupFamilyDiversity,
    });
    const fragile = supportBase && [...groups.keys()].some((groupHash) => !this.supportBaseWithoutGroup(state, domain, groupHash, start, now));
    const holds = Object.values(state.holds).filter((hold) => hold.domain === domain && hold.releasedAt === null && (hold.expiresAt === null || new Date(hold.expiresAt).getTime() > now));
    const withdrawn = holds.find((hold) => hold.holdState === "withdrawn");
    const review = holds.find((hold) => hold.holdState === "review_hold");
    let stateValue: Aggregate["state"];
    let stateReason: string;
    if (withdrawn) { stateValue = "withdrawn"; stateReason = withdrawn.reason === "withdrawn_after_receipt_expiry" ? "withdrawn_after_receipt_expiry" : "withdrawn_by_correction"; }
    else if (review) { stateValue = "review_hold"; stateReason = this.holdReason(review.reason); }
    else if (fragile) { stateValue = "review_hold"; stateReason = "fragile_to_group_removal"; }
    else if (supportBase && this.stage === 1) { stateValue = "review_hold"; stateReason = "stage1_positive_state_disabled"; }
    else if (supportBase) { stateValue = "consistent_support"; stateReason = "support_conditions_met"; }
    else if (D >= 8 && ((supportGroups >= 2 && rejectionGroups >= 2) || (rejection > support && rejectionGroups >= 2) || (support === rejection && support > 0))) {
      stateValue = "mixed_observations";
      stateReason = supportGroups >= 2 && rejectionGroups >= 2 ? "material_conflict" : rejection > support ? "rejection_dominant" : "balanced";
    } else {
      stateValue = "insufficient";
      if (D < POSITIVE_RULE_V03.minCappedDecisiveMassAfterOmission) stateReason = "insufficient_volume";
      else if (!crossGroupFamilyDiversity) stateReason = "model_diversity_unconfirmed";
      else stateReason = "insufficient_support_strength";
    }
    const possibleReasons = [
      withdrawn ? (stateReason === "withdrawn_by_correction" ? "withdrawn_by_correction" : "withdrawn_after_receipt_expiry") : undefined,
      review ? this.holdReason(review.reason) : undefined, fragile ? "fragile_to_group_removal" : undefined,
      supportBase && this.stage === 1 ? "stage1_positive_state_disabled" : undefined,
      !crossGroupFamilyDiversity && D >= 10 ? "model_diversity_unconfirmed" : undefined,
    ].filter((reason): reason is string => Boolean(reason));
    const secondaryStateReasons = [...new Set(possibleReasons.filter((reason) => reason !== stateReason))].slice(0, 5);
    const minimalCount = rollups.reduce((sum, rollup) => sum + rollup.minimalCount, 0);
    const manifestCount = rollups.reduce((sum, rollup) => sum + rollup.manifestCount, 0);
    const evidenceCoverage = minimalCount + manifestCount === 0 ? "none" : manifestCount === 0 ? "minimal_only" : minimalCount === 0 ? "manifest_only" : "partial_manifest";
    const aggregate: Aggregate = {
      domain, support, rejection, insufficient, decisive, groupCount, supportGroupCount: supportGroups,
      rejectionGroupCount: rejectionGroups, familyCount: supportFamilies.size, crossGroupFamilyDiversity,
      maxGroupShare: D > 0 ? maxGroup / D : 0, state: stateValue, stateReason, secondaryStateReasons,
      evidenceCoverage, verificationCoverage: "not_sampled", modelDiversity: D === 0 ? "not_applicable" : crossGroupFamilyDiversity ? "met" : "unconfirmed",
      lastObservedAt, lastEvaluatedAt: iso(now),
    };
    state.aggregates[domain] = aggregate;
    return aggregate;
  }

  private supportBaseWithoutGroup(state: StoreState, domain: string, omittedGroup: string, start: number, end: number): boolean {
    const filtered = Object.values(state.rollups).filter((rollup) => rollup.domain === domain && rollup.provenanceGroupHash !== omittedGroup && isWithin(new Date(rollup.lastObservedAt).getTime(), start, end));
    const groups = new Map<string, { s: number; r: number; u: number; families: Set<ModelFamily> }>();
    for (const rollup of filtered) {
      const group = groups.get(rollup.provenanceGroupHash) ?? { s: 0, r: 0, u: 0, families: new Set<ModelFamily>() };
      group.s += rollup.support; group.r += rollup.rejection; group.u += rollup.insufficient;
      if (rollup.support > 0 && rollup.modelFamily !== "unknown") group.families.add(rollup.modelFamily);
      groups.set(rollup.provenanceGroupHash, group);
    }
    let s = 0, r = 0;
    for (const group of groups.values()) {
      const total = group.s + group.r + group.u; if (total <= 0) continue;
      const cap = Math.min(1, total), factor = cap / total; s += group.s * factor; r += group.r * factor;
    }
    const cross = this.hasCrossGroupFamilyDiversity(groups);
    const D = s + r;
    return this.meetsPositiveRule({
      support: s,
      rejection: r,
      decisive: D,
      crossGroupFamilyDiversity: cross,
    });
  }

  private hasCrossGroupFamilyDiversity(groups: Map<string, { support: number; rejection: number; insufficient: number; families: Set<ModelFamily> }> | Map<string, { s: number; r: number; u: number; families: Set<ModelFamily> }>): boolean {
    const familyGroups = new Map<ModelFamily, Set<string>>();
    for (const [groupHash, group] of groups) {
      const support = "support" in group ? group.support : group.s;
      if (support <= 0) continue;
      for (const family of group.families) {
        if (family === "unknown") continue;
        const set = familyGroups.get(family) ?? new Set<string>(); set.add(groupHash); familyGroups.set(family, set);
      }
    }
    const known = [...familyGroups.entries()].filter(([, groupSet]) => groupSet.size > 0).map(([family]) => family);
    for (let i = 0; i < known.length; i += 1) for (let j = i + 1; j < known.length; j += 1) {
      const left = familyGroups.get(known[i])!, right = familyGroups.get(known[j])!;
      if ([...left].some((group) => !right.has(group)) || [...right].some((group) => !left.has(group))) return true;
    }
    return false;
  }

  private meetsPositiveRule(metrics: CappedDecisionMetrics): boolean {
    if (metrics.decisive < POSITIVE_RULE_V03.minCappedDecisiveMassAfterOmission) return false;
    if (!metrics.crossGroupFamilyDiversity) return false;
    const posteriorMean = (1 + metrics.support) / (2 + metrics.decisive);
    const betaTail = this.betaGreaterThanHalf(1 + metrics.support, 1 + metrics.rejection);
    return posteriorMean >= POSITIVE_RULE_V03.minPosteriorMean && betaTail >= POSITIVE_RULE_V03.minBetaTail;
  }

  private betaGreaterThanHalf(alpha: number, beta: number): number {
    // Simpson integration of the beta density on [0.5, 1]. The values are
    // used only as a conservative gate, never exposed to clients.
    const n = 1000;
    const logBeta = this.logGamma(alpha) + this.logGamma(beta) - this.logGamma(alpha + beta);
    const density = (x: number): number => Math.exp((alpha - 1) * Math.log(x) + (beta - 1) * Math.log(1 - x) - logBeta);
    let sum = density(0.5) + density(1 - 1e-12);
    for (let i = 1; i < n; i += 1) sum += (i % 2 === 0 ? 2 : 4) * density(0.5 + (0.5 * i) / n);
    return Math.min(1, Math.max(0, (0.5 / (3 * n)) * sum));
  }

  private logGamma(x: number): number {
    const coefficients = [0.9999999999998099, 676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * x)) - this.logGamma(1 - x);
    let y = coefficients[0]; const z = x - 1;
    for (let i = 1; i < coefficients.length; i += 1) y += coefficients[i] / (z + i);
    const t = z + coefficients.length - 1.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(y);
  }

  private mixedness(support: number, rejection: number): string {
    const total = support + rejection;
    if (total === 0) return "not_computable";
    const ratio = Math.min(support, rejection) / total;
    if (ratio === 0) return "none";
    if (ratio < 0.2) return "low";
    if (ratio < 0.4) return "material";
    return "balanced";
  }

  private holdReason(reason: string): string {
    const allowed = new Set(["counterevidence_confirmed_domain_wide", "active_objection", "integrity_anomaly", "high_risk_audit_pending", "fragile_to_group_removal", "stage1_positive_state_disabled"]);
    return allowed.has(reason) ? reason : "integrity_anomaly";
  }

  private validateSourceSafety(input: ManifestInput): void {
    for (const source of input.manifest.sources) {
      if (source.url_scope !== "canonical_url") continue;
      if (!source.canonical_url) throw new ServiceError("invalid_url");
      let parsed: URL;
      try { parsed = new URL(source.canonical_url); } catch { throw new ServiceError("invalid_url"); }
      if (parsed.protocol !== "https:" || (parsed.port !== "" && parsed.port !== "443") || parsed.username || parsed.password || parsed.hostname !== source.domain) throw new ServiceError("invalid_url");
      if (this.isPrivateHost(parsed.hostname)) throw new ServiceError("forbidden_url_scope");
    }
  }

  private isPrivateHost(hostname: string): boolean {
    if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
    const octets = hostname.split(".").map(Number);
    if (octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || (octets[0] === 169 && octets[1] === 254) || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
    return false;
  }

  private hasSensitiveCanonicalUrl(input: unknown): boolean {
    const record = input as { question_context?: { sensitivity?: string }; manifest?: { sources?: Array<{ url_scope?: string }> } } | null;
    return record?.question_context?.sensitivity === "sensitive" && Boolean(record.manifest?.sources?.some((source) => source.url_scope === "canonical_url"));
  }

  private earlyManifestUrlError(input: unknown): ErrorResult["code"] | undefined {
    const record = input as { manifest?: { sources?: Array<{ url_scope?: string; canonical_url?: unknown; domain?: string }> } } | null;
    for (const source of record?.manifest?.sources ?? []) {
      if (source.url_scope !== "canonical_url" || typeof source.canonical_url !== "string") continue;
      let parsed: URL;
      try { parsed = new URL(source.canonical_url); } catch { return "invalid_url"; }
      if (parsed.protocol !== "https:" || (parsed.port !== "" && parsed.port !== "443") || parsed.username || parsed.password || parsed.hostname !== source.domain) return "invalid_url";
      if (this.isPrivateHost(parsed.hostname)) return "forbidden_url_scope";
    }
    return undefined;
  }

  private rejectManifest(state: StoreState, researchId: string, tombstoneState: Tombstone["state"]): void {
    const parent = state.manifests[researchId];
    if (parent) {
      for (const batch of Object.values(parent.batches)) for (const sourceRef of batch.sourceRefs) delete state.sourceDecisions[`${researchId}|${sourceRef}`];
      delete state.manifests[researchId];
    }
    state.tombstones[this.researchIdHmac(researchId)] = { researchIdHmac: this.researchIdHmac(researchId), state: tombstoneState, createdAt: iso(nowMs(this.clock)), expiresAt: iso(nowMs(this.clock) + TOMBSTONE_TTL) };
  }

  private runTtl(state: StoreState): { manifestsExpired: number; receiptsDeleted: number; rollupsDeleted: number; tombstonesDeleted: number } {
    const now = nowMs(this.clock);
    let manifestsExpired = 0, receiptsDeleted = 0, rollupsDeleted = 0, tombstonesDeleted = 0;
    for (const [researchId, manifest] of Object.entries(state.manifests)) {
      if (new Date(manifest.firstAcceptedAt).getTime() + MANIFEST_TTL > now) continue;
      const wasAwaiting = manifest.state === "awaiting_batches" || manifest.state === "open";
      for (const batch of Object.values(manifest.batches)) for (const sourceRef of batch.sourceRefs) delete state.sourceDecisions[`${researchId}|${sourceRef}`];
      delete state.manifests[researchId];
      if (wasAwaiting) {
        state.tombstones[this.researchIdHmac(researchId)] = { researchIdHmac: this.researchIdHmac(researchId), state: "expired", createdAt: iso(now), expiresAt: iso(now + TOMBSTONE_TTL) };
        manifestsExpired += 1;
      }
    }
    for (const [receiptId, receipt] of Object.entries(state.receipts)) {
      if (new Date(receipt.observedAt).getTime() + RECEIPT_TTL > now) continue;
      delete state.receipts[receiptId];
      if (state.receiptByResearchId[receipt.researchId] === receiptId) delete state.receiptByResearchId[receipt.researchId];
      const key = this.tokenDomainKey(receipt.tokenHash, receipt.domain, receipt.rubricVersion);
      if (state.receiptByTokenDomain[key] === receiptId) delete state.receiptByTokenDomain[key];
      receiptsDeleted += 1;
    }
    for (const receiptId of Object.keys(state.publicConsents ?? {})) {
      if (!state.receipts[receiptId]) delete state.publicConsents![receiptId];
    }
    for (const [key, rollup] of Object.entries(state.rollups)) if (new Date(rollup.lastObservedAt).getTime() + ROLLUP_TTL <= now) { delete state.rollups[key]; rollupsDeleted += 1; }
    for (const [key, tombstone] of Object.entries(state.tombstones)) if (new Date(tombstone.expiresAt).getTime() <= now) { delete state.tombstones[key]; tombstonesDeleted += 1; }
    for (const [key, verification] of Object.entries(state.verifications)) if (new Date(verification.completedAt).getTime() + MANIFEST_TTL <= now) delete state.verifications[key];
    for (const domain of Object.keys(state.sites)) this.recomputeDomain(state, domain);
    return { manifestsExpired, receiptsDeleted, rollupsDeleted, tombstonesDeleted };
  }

  private authenticate(state: StoreState, context: ToolContext): Participant {
    if (context.oauthSubject) {
      if (!context.oauthScopes?.includes("trust_layer:tools")) throw new ServiceError("not_authorized");
      const tokenHash = this.tokenHash(`oauth-subject:${context.oauthSubject}`);
      const existing = state.participants[tokenHash];
      if (existing) {
        if (existing.stoppedAt) throw new ServiceError("token_invalid");
        return existing;
      }
      const issuedAt = iso(nowMs(this.clock));
      const participant: Participant = {
        participantId: randomUUID(), tokenHash, inviteOriginGroup: `oauth:${this.groupHash(context.oauthSubject).slice(0, 24)}`,
        issuedAt, matureAt: iso(nowMs(this.clock) + 7 * DAY), stoppedAt: null, detailConsent: false, contributionCount: 0,
      };
      state.participants[tokenHash] = participant;
      return participant;
    }
    if (!context.token) throw new ServiceError("token_invalid");
    const token = context.token.replace(/^Bearer\s+/i, "");
    const participant = state.participants[this.tokenHash(token)];
    if (!participant || participant.stoppedAt) throw new ServiceError("token_invalid");
    return participant;
  }

  private capacityRetryAfter(timestamps: readonly string[], windowMs: number, limit: number, units: number, now: number): number | undefined {
    const expirationsNeeded = timestamps.length + units - limit;
    if (expirationsNeeded <= 0) return undefined;
    const sorted = [...timestamps].map((value) => new Date(value).getTime()).sort((left, right) => left - right);
    const releaseAt = sorted[expirationsNeeded - 1] + windowMs;
    return Math.max(1, Math.ceil((releaseAt - now) / 1000));
  }

  private maxRetryAfter(...values: Array<number | undefined>): number | undefined {
    const defined = values.filter((value): value is number => value !== undefined);
    return defined.length === 0 ? undefined : Math.max(...defined);
  }

  private inputUnits(tool: ToolName, rawInput: unknown): number {
    if (tool !== "report_domain_assessments_batch") return 1;
    const entries = isRecord(rawInput) ? rawInput.assessments : undefined;
    return Array.isArray(entries) ? Math.min(5, Math.max(1, entries.length)) : 1;
  }

  private invalidUnitsForOuterBatch(rawInput: unknown): number {
    return this.inputUnits("report_domain_assessments_batch", rawInput);
  }

  private inputResourceRetryAfter(state: StoreState, tokenHash: string, units: number): number | undefined {
    if (!Number.isInteger(units) || units < 1 || units > 5) throw new Error("invalid input resource units");
    const now = nowMs(this.clock);
    const usage = state.inputUsage[tokenHash] ?? { all: [], invalid: [], cooldownUntil: null };
    usage.all = usage.all.filter((value) => now - new Date(value).getTime() < INPUT_LONG);
    usage.invalid = usage.invalid.filter((value) => now - new Date(value).getTime() < INPUT_SHORT);
    if (usage.cooldownUntil && new Date(usage.cooldownUntil).getTime() <= now) usage.cooldownUntil = null;
    const inShortWindow = usage.all.filter((value) => now - new Date(value).getTime() < INPUT_SHORT);
    const waits = [
      usage.cooldownUntil === null ? undefined : Math.max(1, Math.ceil((new Date(usage.cooldownUntil!).getTime() - now) / 1000)),
      this.capacityRetryAfter(inShortWindow, INPUT_SHORT, 30, units, now),
      this.capacityRetryAfter(usage.all, INPUT_LONG, 300, units, now),
    ].filter((value): value is number => value !== undefined);
    state.inputUsage[tokenHash] = usage;
    return this.maxRetryAfter(...waits);
  }

  private assertInputResource(state: StoreState, tokenHash: string, units: number): void {
    const retryAfter = this.inputResourceRetryAfter(state, tokenHash, units);
    if (retryAfter !== undefined) throw new ServiceError("rate_limited", retryAfter);
    const usage = state.inputUsage[tokenHash]!;
    const now = nowMs(this.clock);
    usage.all.push(...Array.from({ length: units }, () => iso(now)));
    state.inputUsage[tokenHash] = usage;
  }

  private noteInvalidBatchItems(state: StoreState, tokenHash: string, units: number): BatchInvalidCooldown | undefined {
    if (!Number.isInteger(units) || units < 1 || units > 5) throw new Error("invalid batch invalid units");
    const now = nowMs(this.clock);
    const usage = state.inputUsage[tokenHash] ?? { all: [], invalid: [], cooldownUntil: null };
    usage.all = usage.all.filter((value) => now - new Date(value).getTime() < INPUT_LONG);
    usage.invalid = usage.invalid.filter((value) => now - new Date(value).getTime() < INPUT_SHORT);
    if (usage.cooldownUntil && new Date(usage.cooldownUntil).getTime() <= now) usage.cooldownUntil = null;
    if (usage.cooldownUntil && new Date(usage.cooldownUntil).getTime() > now) {
      state.inputUsage[tokenHash] = usage;
      return {
        kind: "existing_active",
        retryAfterSeconds: Math.max(1, Math.ceil((new Date(usage.cooldownUntil).getTime() - now) / 1000)),
      };
    }
    usage.invalid.push(...Array.from({ length: units }, () => iso(now)));
    if (usage.invalid.length >= 5) {
      usage.cooldownUntil = iso(now + INPUT_SHORT);
      state.inputUsage[tokenHash] = usage;
      return { kind: "started", retryAfterSeconds: Math.max(1, Math.ceil(INPUT_SHORT / 1000)) };
    }
    state.inputUsage[tokenHash] = usage;
    return undefined;
  }

  private markInvalid(state: StoreState, tokenHash: string): ErrorResult["code"] | undefined {
    const usage = state.inputUsage[tokenHash] ?? { all: [], invalid: [], cooldownUntil: null } as InputUsage;
    const now = nowMs(this.clock); usage.invalid = usage.invalid.filter((value) => now - new Date(value).getTime() < INPUT_SHORT); usage.invalid.push(iso(now));
    if (usage.invalid.length >= 5) { usage.cooldownUntil = iso(now + INPUT_SHORT); state.inputUsage[tokenHash] = usage; return "rate_limited"; }
    state.inputUsage[tokenHash] = usage; return undefined;
  }

  private assertAssessmentRate(state: StoreState, tokenHash: string, units = 1): void {
    if (!Number.isInteger(units) || units < 1 || units > 5) throw new Error("invalid assessment units");
    const now = nowMs(this.clock);
    const inLong = (state.assessmentUsage[tokenHash] ?? []).filter((value) => now - new Date(value).getTime() < ASSESSMENT_LONG);
    const inShort = inLong.filter((value) => now - new Date(value).getTime() < ASSESSMENT_SHORT);
    state.assessmentUsage[tokenHash] = inLong;
    const waits = [
      this.capacityRetryAfter(inShort, ASSESSMENT_SHORT, 10, units, now),
      this.capacityRetryAfter(inLong, ASSESSMENT_LONG, 50, units, now),
    ].filter((value): value is number => value !== undefined);
    if (waits.length > 0) throw new ServiceError("rate_limited", Math.max(...waits));
  }

  private remainingAssessment(state: StoreState, tokenHash: string): number {
    const now = nowMs(this.clock); const values = (state.assessmentUsage[tokenHash] ?? []).filter((value) => now - new Date(value).getTime() < DAY); state.assessmentUsage[tokenHash] = values; return Math.max(0, 50 - values.length);
  }

  private weightFor(participant: Participant, state: StoreState, now: number): number {
    return now >= new Date(participant.matureAt).getTime() && participant.contributionCount >= 10 ? 1 : 0.25;
  }

  private tokenHash(token: string): string { return createHmac("sha256", this.secret).update(token).digest("hex"); }
  private groupHash(group: string): string { return createHmac("sha256", this.secret).update(`group:${group}`).digest("hex"); }
  private researchIdHmac(researchId: string): string { return createHmac("sha256", this.secret).update(`research:${researchId}`).digest("hex"); }
  private requestDigest(value: unknown): string { return `d_${createHmac("sha256", this.secret).update(stableStringify(value)).digest("base64url").slice(0, 43)}`; }
  private tokenDomainKey(tokenHash: string, domain: string, rubric: string): string { return `${tokenHash}|${domain}|${rubric}`; }

  private replaceState(target: StoreState, source: StoreState): void {
    const replacement = cloneState(source);
    Object.assign(target, replacement);
  }

  private error(
    code: ErrorResult["code"],
    digest: string,
    retryAfterSeconds?: number,
    retryDirective?: "fix_request_then_retry_after_delay",
  ): ErrorResult {
    const result: ErrorResult = { ok: false, code, request_digest: digest };
    if (code === "rate_limited") result.retry_after_seconds = retryAfterSeconds ?? 600;
    if (retryDirective !== undefined) {
      result.retry_directive = retryDirective;
      result.retry_after_seconds = retryAfterSeconds!;
    }
    if (!this.catalog.validateError(result).valid) throw new Error("invalid error response");
    return result;
  }
}
