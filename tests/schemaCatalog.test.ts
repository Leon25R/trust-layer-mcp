import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createMcpServer, mcpInputAccepts, mcpInputSchemas } from "../src/server.js";
import { TrustLayerService } from "../src/service.js";
import { SchemaCatalog } from "../src/schemaCatalog.js";

const uuid = "11111111-1111-4111-8111-111111111111";
const validAssessment = { research_id: uuid, collection_mode: "minimal_observation", rubric_version: "0.3", domain: "example.com", outcome: "used_as_support", reason_code: "direct_evidence", agent_model_name: "openai_gpt5" };
const validVerification = { attestation_schema_version: "0.1", research_id: uuid, verification_mode: "local_byo_api", rubric_version: "0.3", checked_source_refs: ["s1"], result: "consistent", result_codes: ["primary_source_found"], alternative_source_refs: [], client_verifier_version: "0.1" };
const validContext = { intent_category: "factual_lookup", claim_scope_tags: ["product_spec"], sensitivity: "standard" };
const source = { source_ref: "s1", url_scope: "domain_only", domain: "example.com", source_disposition: "used_as_support", reason_codes: ["primary_source"], related_source_refs: [], source_type: "primary", published_date_precision: "day" };
const validManifest = { research_id: uuid, collection_mode: "evidence_manifest", rubric_version: "0.3", agent_model_name: "openai_gpt5", question_context: validContext, manifest: { source_count_total: 1, batch_index: 1, batch_count: 1, complete: true, sources: [source], final_assessment: { domain: "example.com", outcome: "used_as_support", reason_code: "direct_evidence" } } };
const validBatch = { assessments: [validAssessment] };

function schemaKeywordValues(value: unknown, keyword: "$id" | "$ref"): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => schemaKeywordValues(item, keyword));
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record[keyword] === "string" ? [record[keyword]] : []),
    ...Object.values(record).flatMap((item) => schemaKeywordValues(item, keyword)),
  ];
}

describe("absolute schema catalog and independent contracts", () => {
  it("loads all external refs from one HTTPS base", () => {
    const catalog = new SchemaCatalog();
    for (const [name, schema] of Object.entries(catalog.schemas)) {
      expect((schema as { $id: string }).$id).toMatch(/^https:\/\/schemas\.trust-layer\.local\/v0\.3\//);
      expect(catalog.schemaId(name as never)).toMatch(/^https:\/\//);
      for (const id of schemaKeywordValues(schema, "$id")) expect(id).toMatch(/^https:\/\/schemas\.trust-layer\.local\/v0\.3\//);
      for (const ref of schemaKeywordValues(schema, "$ref")) expect(ref).toMatch(/^https:\/\/schemas\.trust-layer\.local\/v0\.3\//);
    }
    expect(catalog.validateInput("report_domain_assessment", validAssessment).valid).toBe(true);
    expect(catalog.validateInput("report_domain_assessments_batch", validBatch).valid).toBe(true);
    expect(catalog.validateInput("report_research_manifest", validManifest).valid).toBe(true);
  });

  it.each([
    ["report_domain_assessment", validAssessment],
    ["report_research_manifest", validManifest],
    ["submit_local_verification", validVerification],
    ["lookup_domain_signal", { domain: "example.com" }],
  ] as const)("accepts only request schema for %s", (tool, input) => {
    const catalog = new SchemaCatalog();
    expect(catalog.validateInput(tool, input).valid).toBe(true);
    const success = tool === "report_domain_assessment"
      ? { ok: true, code: "accepted", receipt_id: "r_1234567890123456", remaining_24h: 49, aggregate_effect: "eligible" }
      : tool === "report_research_manifest"
        ? { ok: true, code: "accepted", manifest_receipt_id: "m_1234567890123456", batch_status: "complete_eligible", rate_charge: "new_final_assessment", remaining_24h: 49 }
        : tool === "submit_local_verification"
          ? { ok: true, code: "accepted", attestation_id: "v_1234567890123456", verification_effect: "self_report_recorded_no_weight" }
          : { ok: true, domain: "example.com", state: "insufficient", state_reason: "insufficient_volume", aggregate_window: { kind: "rolling", days: 90, window_start: "2026-01-01T00:00:00.000Z" }, last_observed_at: null, last_evaluated_at: "2026-08-24T00:00:00.000Z", decisive_observation_band: "0", mixedness: "not_computable", evidence_coverage: "none", verification_coverage: "not_sampled", model_diversity: "not_applicable", cautions: ["not_truth_claim"] };
    expect(catalog.validateSuccess(tool, success).valid).toBe(true);
    expect(catalog.validateInput(tool, success).valid).toBe(false);
    expect(catalog.validateError({ ok: false, code: "invalid_schema", request_digest: "d_1234567890123456" }).valid).toBe(true);
    expect(catalog.validateInput(tool, { ok: false, code: "invalid_schema", request_digest: "d_1234567890123456" }).valid).toBe(false);
  });

  it("rejects non-v4, uppercase, and variant UUIDs in all 3 shared-reference tools", () => {
    const catalog = new SchemaCatalog();
    for (const value of ["11111111-1111-1111-8111-111111111111", "11111111-1111-3111-8111-111111111111", "11111111-1111-5111-8111-111111111111", "11111111-1111-4111-c111-111111111111", "11111111-1111-4111-8111-11111111111A"]) {
      expect(catalog.validateInput("report_domain_assessment", { ...validAssessment, research_id: value }).valid).toBe(false);
      expect(catalog.validateInput("report_research_manifest", { ...validManifest, research_id: value }).valid).toBe(false);
      expect(catalog.validateInput("submit_local_verification", { ...validVerification, research_id: value }).valid).toBe(false);
    }
  });

  it("enforces closed canonical_url/domain_only union and sensitive URL prohibition", () => {
    const catalog = new SchemaCatalog();
    const canonical = { ...source, url_scope: "canonical_url", canonical_url: "https://example.com/p" };
    expect(catalog.validateInput("report_research_manifest", { ...validManifest, manifest: { ...validManifest.manifest, sources: [canonical] } }).valid).toBe(true);
    expect(catalog.validateInput("report_research_manifest", { ...validManifest, manifest: { ...validManifest.manifest, sources: [{ ...source, canonical_url: "https://example.com/p" }] } }).valid).toBe(false);
    expect(catalog.validateInput("report_research_manifest", { ...validManifest, question_context: { ...validContext, sensitivity: "sensitive" }, manifest: { ...validManifest.manifest, sources: [canonical] } }).valid).toBe(false);
  });

  it("keeps the batch outer schema closed while transport validation remains permissive", () => {
    const catalog = new SchemaCatalog();
    expect(catalog.validateInput("report_domain_assessments_batch", validBatch).valid).toBe(true);
    expect(catalog.validateInput("report_domain_assessments_batch", { ...validBatch, unexpected: true }).valid).toBe(false);
    expect(catalog.validateInput("report_domain_assessments_batch", {}).valid).toBe(false);
    expect(catalog.validateInput("report_domain_assessments_batch", { assessments: [] }).valid).toBe(false);
    expect(catalog.validateInput("report_domain_assessments_batch", { assessments: [validAssessment, validAssessment, validAssessment, validAssessment, validAssessment, validAssessment] }).valid).toBe(false);
    expect(mcpInputAccepts("report_domain_assessments_batch", { ...validBatch, unexpected: true })).toBe(true);
    expect(mcpInputAccepts("report_domain_assessments_batch", {})).toBe(true);
    expect(mcpInputAccepts("report_domain_assessments_batch", { assessments: "not-an-array" })).toBe(true);
  });

  it("validates all batch success and rejected variants and rejects mismatched directives", () => {
    const catalog = new SchemaCatalog();
    const accepted = (itemIndex: number): Record<string, unknown> => ({ item_index: itemIndex, status: "accepted", receipt_id: "r_1234567890123456", aggregate_effect: "pending_weight", rate_charge: "new_token_domain", remaining_24h_after_item: 49 });
    const idempotent = (itemIndex: number): Record<string, unknown> => ({ item_index: itemIndex, status: "accepted_idempotent", receipt_id: "r_1234567890123456", aggregate_effect: "eligible", rate_charge: "none_idempotent", remaining_24h_after_item: 49 });
    const rejected = (itemIndex: number, error_code: string, retry_directive: string, retry_after_seconds?: number): Record<string, unknown> => ({ item_index: itemIndex, status: "rejected", error_code, retry_directive, ...(retry_after_seconds === undefined ? {} : { retry_after_seconds }) });
    const wrap = (result: Record<string, unknown>): Record<string, unknown> => ({ ok: true, code: "batch_processed", batch_outcome: result.status === "rejected" ? "all_rejected" : "all_accepted", processed_count: 1, accepted_count: result.status === "accepted" ? 1 : 0, idempotent_count: result.status === "accepted_idempotent" ? 1 : 0, rejected_count: result.status === "rejected" ? 1 : 0, remaining_24h: 49, results: [result] });
    const variants = [
      accepted(0), idempotent(0),
      rejected(0, "invalid_schema", "fix_input_then_retry"),
      rejected(0, "invalid_schema", "fix_input_then_retry_after_delay", 600),
      rejected(0, "duplicate_research_id_in_batch", "remove_duplicate_then_retry"),
      rejected(0, "duplicate_research_id_in_batch", "remove_duplicate_then_retry_after_delay", 600),
      rejected(0, "research_id_conflict", "do_not_retry_same_research_id"),
      rejected(0, "batch_expired", "do_not_retry_same_research_id"),
      rejected(0, "rate_limited", "retry_same_research_id_after_delay", 600),
      rejected(0, "internal_error", "retry_same_research_id"),
    ];
    for (const result of variants) expect(catalog.validateSuccess("report_domain_assessments_batch", wrap(result)).valid).toBe(true);
    expect(catalog.validateSuccess("report_domain_assessments_batch", wrap(rejected(0, "research_id_conflict", "retry_same_research_id"))).valid).toBe(false);
    expect(catalog.validateSuccess("report_domain_assessments_batch", wrap(rejected(0, "invalid_schema", "remove_duplicate_then_retry"))).valid).toBe(false);
    expect(catalog.validateSuccess("report_domain_assessments_batch", wrap(rejected(0, "rate_limited", "retry_same_research_id_after_delay"))).valid).toBe(false);
  });

  it("accepts only the batch common-error retry directive variant", () => {
    const catalog = new SchemaCatalog();
    const base = { ok: false, code: "invalid_schema", request_digest: "d_1234567890123456" };
    expect(catalog.validateError(base).valid).toBe(true);
    expect(catalog.validateError({ ...base, retry_after_seconds: 600, retry_directive: "fix_request_then_retry_after_delay" }).valid).toBe(true);
    expect(catalog.validateError({ ...base, retry_after_seconds: 600 }).valid).toBe(false);
    expect(catalog.validateError({ ...base, retry_directive: "fix_request_then_retry_after_delay" }).valid).toBe(false);
    expect(catalog.validateError({ ...base, code: "rate_limited", retry_after_seconds: 600 }).valid).toBe(true);
    expect(catalog.validateError({ ...base, code: "rate_limited", retry_after_seconds: 600, retry_directive: "fix_request_then_retry_after_delay" }).valid).toBe(false);
  });

  it("keeps the PostgreSQL-compatible migration at all 14 design tables", () => {
    const sql = readFileSync(new URL("../migrations/001_trust_layer.sql", import.meta.url), "utf8");
    expect((sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length).toBe(14);
    for (const table of ["participants", "sites", "site_aggregates", "site_aggregate_daily_rollups", "assessment_event_receipts", "research_manifests", "source_decisions", "manifest_id_tombstones", "verification_jobs", "site_verification_daily_rollups", "aggregate_corrections", "domain_holds", "model_family_map", "model_calibration_aggregates"]) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
  });

  it("uses strict MCP registration schemas and agrees with the JSON catalog on request vectors", () => {
    const catalog = new SchemaCatalog();
    const vectors: Record<string, unknown[]> = {
      report_domain_assessment: [validAssessment, { ...validAssessment, unexpected: true }],
      report_research_manifest: [validManifest, { ...validManifest, unexpected: true }, { ...validManifest, manifest: { ...validManifest.manifest, sources: [{ ...source, unexpected: true }] } }],
      submit_local_verification: [validVerification, { ...validVerification, unexpected: true }],
      lookup_domain_signal: [{ domain: "example.com" }, { domain: "example.com", unexpected: true }],
    };
    for (const [tool, cases] of Object.entries(vectors) as Array<[keyof typeof mcpInputSchemas, unknown[]]>) {
      expect(mcpInputSchemas[tool]).toBeDefined();
      for (const value of cases) expect(mcpInputAccepts(tool, value)).toBe(catalog.validateInput(tool, value).valid);
    }
    expect(mcpInputAccepts("report_domain_assessment", validAssessment)).toBe(true);
    expect(mcpInputAccepts("report_domain_assessment", { ...validAssessment, unknown: "reject-me" })).toBe(false);
    const server = createMcpServer(new TrustLayerService({ dbFile: null, secret: "schema-registration" }));
    const registered = (server as unknown as { _registeredTools: Record<string, { inputSchema: unknown }> })._registeredTools;
    for (const tool of Object.keys(mcpInputSchemas)) expect(registered[tool]?.inputSchema).toBe(mcpInputSchemas[tool as keyof typeof mcpInputSchemas]);
  });
});
