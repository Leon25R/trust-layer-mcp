export type Outcome = "used_as_support" | "rejected_or_conflicted" | "insufficient_evidence";
export type ModelName = "openai_gpt5" | "anthropic_claude4" | "google_gemini3" | "local_fixed" | "other_fixed" | "unknown";
export type ModelFamily = "openai" | "anthropic" | "google" | "local" | "other" | "unknown";

export interface Clock {
  now(): Date;
}

export interface Participant {
  participantId: string;
  tokenHash: string;
  inviteOriginGroup: string;
  issuedAt: string;
  matureAt: string;
  stoppedAt: string | null;
  detailConsent: boolean;
  contributionCount: number;
}

export interface AssessmentInput {
  research_id: string;
  collection_mode: "minimal_observation";
  rubric_version: "0.3";
  guidance_version?: string;
  domain: string;
  outcome: Outcome;
  reason_code: "direct_evidence" | "primary_source_conflict" | "stale_or_changed" | "citation_missing" | "unclear";
  agent_model_name: ModelName;
}

/** The batch container is intentionally loose; each member is validated independently. */
export interface AssessmentBatchInput {
  assessments: unknown[];
}

export type BatchAggregateEffect = "eligible" | "pending_weight" | "deduplicated";
export type BatchRateCharge = "new_token_domain" | "none_already_contributed" | "none_idempotent";
export type BatchRejectedErrorCode =
  | "invalid_schema"
  | "duplicate_research_id_in_batch"
  | "research_id_conflict"
  | "batch_expired"
  | "rate_limited"
  | "internal_error";
export type BatchRetryDirective =
  | "fix_input_then_retry"
  | "fix_input_then_retry_after_delay"
  | "remove_duplicate_then_retry"
  | "remove_duplicate_then_retry_after_delay"
  | "do_not_retry_same_research_id"
  | "retry_same_research_id_after_delay"
  | "retry_same_research_id";

export interface BatchAcceptedResult {
  item_index: number;
  status: "accepted";
  receipt_id: string;
  aggregate_effect: BatchAggregateEffect;
  rate_charge: "new_token_domain" | "none_already_contributed";
  remaining_24h_after_item: number;
}

export interface BatchIdempotentResult {
  item_index: number;
  status: "accepted_idempotent";
  receipt_id: string;
  aggregate_effect: "eligible" | "deduplicated";
  rate_charge: "none_idempotent";
  remaining_24h_after_item: number;
}

export interface BatchRejectedResult {
  item_index: number;
  status: "rejected";
  error_code: BatchRejectedErrorCode;
  retry_directive: BatchRetryDirective;
  retry_after_seconds?: number;
}

export type BatchItemResult = BatchAcceptedResult | BatchIdempotentResult | BatchRejectedResult;

export interface BatchSuccessResult extends SuccessResult {
  code: "batch_processed";
  batch_outcome: "all_accepted" | "partial_success" | "all_rejected";
  processed_count: number;
  accepted_count: number;
  idempotent_count: number;
  rejected_count: number;
  remaining_24h: number;
  results: BatchItemResult[];
}

export interface SourceEntry {
  source_ref: string;
  url_scope: "canonical_url" | "domain_only";
  canonical_url?: string;
  domain: string;
  source_disposition: "used_as_support" | "rejected_or_conflicted" | "considered_not_relied" | "unreadable";
  reason_codes: string[];
  related_source_refs: string[];
  source_type: "primary" | "regulator" | "publisher" | "community" | "unknown";
  published_date_precision: "day" | "month" | "year" | "unknown";
}

export interface ManifestInput {
  research_id: string;
  collection_mode: "evidence_manifest";
  rubric_version: "0.3";
  guidance_version?: string;
  agent_model_name: ModelName;
  question_context: {
    intent_category: string;
    claim_scope_tags: string[];
    sensitivity: "standard" | "sensitive";
  };
  manifest: {
    source_count_total: number;
    batch_index: number;
    batch_count: number;
    complete: boolean;
    sources: SourceEntry[];
    final_assessment?: {
      domain: string;
      outcome: Outcome;
      reason_code: AssessmentInput["reason_code"];
    };
  };
}

export interface VerificationInput {
  attestation_schema_version: "0.1";
  research_id: string;
  verification_mode: "local_byo_api";
  rubric_version: "0.3";
  checked_source_refs: string[];
  result: "consistent" | "inconsistent" | "inconclusive";
  result_codes: string[];
  alternative_source_refs: string[];
  client_verifier_version: "0.1";
}

export interface LookupInput { domain: string; }

export interface Aggregate {
  domain: string;
  support: number;
  rejection: number;
  insufficient: number;
  decisive: number;
  groupCount: number;
  supportGroupCount: number;
  rejectionGroupCount: number;
  familyCount: number;
  crossGroupFamilyDiversity: boolean;
  maxGroupShare: number;
  state: "insufficient" | "consistent_support" | "mixed_observations" | "review_hold" | "withdrawn";
  stateReason: string;
  secondaryStateReasons: string[];
  evidenceCoverage: "none" | "minimal_only" | "partial_manifest" | "manifest_only";
  verificationCoverage: "not_sampled" | "inconclusive_only" | "source_hygiene_spot_checked" | "audit_hold";
  modelDiversity: "not_applicable" | "unconfirmed" | "met";
  lastObservedAt: string | null;
  lastEvaluatedAt: string;
}

export interface Rollup {
  key: string;
  domain: string;
  observedDate: string;
  lastObservedAt: string;
  provenanceGroupHash: string;
  modelFamily: ModelFamily;
  support: number;
  rejection: number;
  insufficient: number;
  minimalCount: number;
  manifestCount: number;
}

export interface PublicObservationConsent {
  receiptId: string;
  principalId: string;
  consentVersion: "public-observation-v1";
  consentedAt: string;
  revokedAt: string | null;
}

export interface Receipt {
  receiptId: string;
  researchId: string;
  domain: string;
  outcome: Outcome;
  reasonCode: string;
  rubricVersion: string;
  guidanceVersion?: string;
  tokenHash: string;
  provenanceGroupHash: string;
  modelName: ModelName;
  modelFamily: ModelFamily;
  appliedWeight: number;
  observedAt: string;
  payloadDigest: string;
  /** Absent legacy records are not eligible for public sharing. */
  publicEligible?: boolean;
}

export interface ManifestBatch {
  digest: string;
  index: number;
  complete: boolean;
  sourceRefs: string[];
  payload: ManifestInput["manifest"];
}

export interface ResearchManifest {
  researchId: string;
  tokenHash: string;
  rubricVersion: string;
  guidanceVersion?: string;
  collectionMode: "evidence_manifest";
  agentModelName: ModelName;
  questionContext: ManifestInput["question_context"];
  sourceCountTotal: number;
  batchCount: number;
  firstAcceptedAt: string;
  state: "open" | "awaiting_batches" | "complete_eligible" | "rejected" | "expired";
  batches: Record<string, ManifestBatch>;
  finalAssessment?: NonNullable<ManifestInput["manifest"]["final_assessment"]>;
  manifestReceiptId: string;
}

export interface SourceDecision extends SourceEntry {
  researchId: string;
}

export interface Tombstone {
  researchIdHmac: string;
  state: "rejected" | "expired";
  createdAt: string;
  expiresAt: string;
}

export interface Verification {
  attestationId: string;
  researchId: string;
  tokenHash: string;
  checkedSourceRefs: string[];
  result: VerificationInput["result"];
  digest: string;
  completedAt: string;
}

export interface Hold {
  /** Explicit human approval; absence is private. */
  publicApproved?: boolean;
  domain: string;
  holdState: "review_hold" | "withdrawn";
  reason: string;
  startedAt: string;
  expiresAt: string | null;
  releasedAt: string | null;
}

export interface InputUsage { all: string[]; invalid: string[]; cooldownUntil: string | null; }

export interface StoreState {
  publicConsents?: Record<string, PublicObservationConsent>;
  /** Verified operator-managed identity bindings, never inferred from groups. */
  publicPrincipalBindings?: Record<string, string>;
  participants: Record<string, Participant>;
  sites: Record<string, { domain: string; firstObservedAt: string }>;
  aggregates: Record<string, Aggregate>;
  rollups: Record<string, Rollup>;
  receipts: Record<string, Receipt>;
  manifests: Record<string, ResearchManifest>;
  sourceDecisions: Record<string, SourceDecision>;
  tombstones: Record<string, Tombstone>;
  verifications: Record<string, Verification>;
  holds: Record<string, Hold>;
  inputUsage: Record<string, InputUsage>;
  assessmentUsage: Record<string, string[]>;
  modelFamilyMap: Record<string, ModelFamily>;
  receiptByTokenDomain: Record<string, string>;
  receiptByResearchId: Record<string, string>;
}

export interface ToolContext {
  token?: string;
  origin?: string;
  oauthSubject?: string;
  oauthScopes?: readonly string[];
}

export interface OAuthClient {
  clientId: string;
  redirectUris: string[];
  createdAt: string;
}

export interface OAuthAuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string[];
  subject: string;
  expiresAt: string;
}

export interface OAuthRefreshToken {
  clientId: string;
  resource: string;
  scope: string[];
  subject: string;
  expiresAt: string;
}

export interface OAuthState {
  clients: Record<string, OAuthClient>;
  authorizationCodes: Record<string, OAuthAuthorizationCode>;
  refreshTokens: Record<string, OAuthRefreshToken>;
}

export interface SuccessResult { ok: true; [key: string]: unknown; }
export interface ErrorResult {
  [key: string]: unknown;
  ok: false;
  code: "invalid_schema" | "invalid_enum" | "invalid_reference" | "invalid_url" | "forbidden_url_scope" | "batch_incomplete" | "batch_expired" | "research_id_conflict" | "token_invalid" | "origin_not_allowed" | "rate_limited" | "not_found" | "not_authorized" | "internal_error";
  request_digest: string;
  retry_after_seconds?: number;
  retry_directive?: "fix_request_then_retry_after_delay";
}
export type ToolResult = SuccessResult | BatchSuccessResult | ErrorResult;
