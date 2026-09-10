import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MutableClock } from "../src/clock.js";
import { PostgresCompatDatabase } from "../src/db.js";
import { mcpInputAccepts } from "../src/server.js";
import { TrustLayerService } from "../src/service.js";
import type { ModelFamily, ModelName, Receipt, StoreState } from "../src/types.js";

const uuid = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const assessment = (research_id: string, domain = "example.com", guidance_version?: string) => ({ research_id, collection_mode: "minimal_observation" as const, rubric_version: "0.3" as const, ...(guidance_version === undefined ? {} : { guidance_version }), domain, outcome: "used_as_support" as const, reason_code: "direct_evidence" as const, agent_model_name: "openai_gpt5" as const });
const context = { intent_category: "factual_lookup" as const, claim_scope_tags: ["product_spec" as const], sensitivity: "standard" as const };
const source = (ref: string, domain = "example.com") => ({ source_ref: ref, url_scope: "domain_only" as const, domain, source_disposition: "used_as_support" as const, reason_codes: ["primary_source" as const], related_source_refs: [] as string[], source_type: "primary" as const, published_date_precision: "day" as const });
const manifest = (research_id: string, batchIndex: number, batchCount: number, complete: boolean, sources: ReturnType<typeof source>[], total = sources.length, guidance_version?: string) => ({ research_id, collection_mode: "evidence_manifest" as const, rubric_version: "0.3" as const, ...(guidance_version === undefined ? {} : { guidance_version }), agent_model_name: "openai_gpt5" as const, question_context: context, manifest: { source_count_total: total, batch_index: batchIndex, batch_count: batchCount, complete, sources, ...(complete ? { final_assessment: { domain: "example.com", outcome: "used_as_support" as const, reason_code: "direct_evidence" as const } } : {}) } });
const batch = (...items: unknown[]) => ({ assessments: items });

async function issueEligibleToken(service: TrustLayerService, clock: MutableClock, group: string, sequence: number) {
  const issued = await service.issueSyntheticToken(group);
  for (let offset = 0; offset < 10; offset += 1) {
    const result = await service.executeTool(
      "report_domain_assessment",
      assessment(uuid(10_000 + sequence * 100 + offset), `warm-${sequence}-${offset}.example.com`),
      { token: issued.token },
    );
    if (!result.ok) throw new Error(`warmup failed for ${group}/${offset}: ${JSON.stringify(result)}`);
    clock.advanceMs(11 * 60_000);
  }
  clock.advanceDays(7);
  return issued;
}

async function submitSupport(service: TrustLayerService, token: string, researchId: number, model: ModelName, domain = "example.com") {
  expect(await service.executeTool(
    "report_domain_assessment",
    { ...assessment(uuid(researchId), domain), agent_model_name: model },
    { token },
  )).toMatchObject({ ok: true });
}

function stateOf(service: TrustLayerService): StoreState {
  return (service as unknown as { state: StoreState }).state;
}

function tokenHashOf(service: TrustLayerService, token: string): string {
  const state = stateOf(service);
  const participant = Object.values(state.participants).find((candidate) => candidate.participantId !== "" && candidate.tokenHash);
  if (!participant) throw new Error("participant not found");
  return participant.tokenHash;
}

describe("Trust Layer persistence and transaction behavior", () => {
  it("executes canonical migration and persists an assessment through the test adapter", async () => {
    const database = new PostgresCompatDatabase();
    const service = new TrustLayerService({ database, clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "db-test" });
    const issued = await service.issueSyntheticToken("db-group");
    expect(await service.executeTool("report_domain_assessment", assessment(uuid(90)), { token: issued.token })).toMatchObject({ ok: true });
    expect(database.tableCount()).toBe(14);
    expect(database.rowCount("participants")).toBe(1);
    expect(database.rowCount("assessment_event_receipts")).toBe(1);
    expect(database.rowCount("site_aggregate_daily_rollups")).toBe(1);
    expect(database.persistedTransactionCount).toBe(14);
  });

  it("accepts three independent assessments and matches the single-submit aggregate snapshot", async () => {
    const clock = new MutableClock("2026-08-24T00:00:00Z");
    const batchService = new TrustLayerService({ clock, secret: "batch-equivalence" });
    const singleService = new TrustLayerService({ clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "batch-equivalence" });
    const batchToken = await batchService.issueSyntheticToken("equivalence-group");
    const singleToken = await singleService.issueSyntheticToken("equivalence-group");
    const items = [1, 2, 3].map((n) => assessment(uuid(300 + n), `batch${n}.example.com`));
    const result = await batchService.executeTool("report_domain_assessments_batch", batch(...items), { token: batchToken.token });
    expect(result).toMatchObject({ ok: true, code: "batch_processed", batch_outcome: "all_accepted", processed_count: 3, accepted_count: 3, idempotent_count: 0, rejected_count: 0 });
    expect(batchService.snapshot().counts.receipts).toBe(3);
    for (const item of items) expect(await singleService.executeTool("report_domain_assessment", item, { token: singleToken.token })).toMatchObject({ ok: true, code: "accepted" });
    expect(batchService.snapshot().aggregates).toEqual(singleService.snapshot().aggregates);
  });

  it("is idempotent across single-to-batch and batch-to-single submission paths", async () => {
    const first = new TrustLayerService({ clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "cross-path-idempotency" });
    const firstToken = await first.issueSyntheticToken("idempotency-group");
    const item = assessment(uuid(310), "idempotent.example.com");
    expect(await first.executeTool("report_domain_assessment", item, { token: firstToken.token })).toMatchObject({ ok: true, code: "accepted" });
    const before = first.snapshot();
    expect(await first.executeTool("report_domain_assessments_batch", batch(item), { token: firstToken.token })).toMatchObject({ ok: true, results: [{ status: "accepted_idempotent", rate_charge: "none_idempotent" }] });
    expect(first.snapshot()).toEqual(before);

    const second = new TrustLayerService({ clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "cross-path-idempotency-2" });
    const secondToken = await second.issueSyntheticToken("idempotency-group");
    expect(await second.executeTool("report_domain_assessments_batch", batch(item), { token: secondToken.token })).toMatchObject({ ok: true, results: [{ status: "accepted" }] });
    const secondBefore = second.snapshot();
    expect(await second.executeTool("report_domain_assessment", item, { token: secondToken.token })).toMatchObject({ ok: true, code: "accepted_idempotent" });
    expect(second.snapshot()).toEqual(secondBefore);
  });

  it("keeps a research_id conflict local while accepting valid neighbors", async () => {
    const service = new TrustLayerService({ clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "batch-conflict" });
    const issued = await service.issueSyntheticToken("conflict-group");
    const conflicting = assessment(uuid(320), "original.example.com");
    expect(await service.executeTool("report_domain_assessment", conflicting, { token: issued.token })).toMatchObject({ ok: true });
    const result = await service.executeTool("report_domain_assessments_batch", batch(
      assessment(uuid(321), "before.example.com"),
      { ...conflicting, domain: "changed.example.com" },
      assessment(uuid(322), "after.example.com"),
    ), { token: issued.token });
    expect(result).toMatchObject({ ok: true, batch_outcome: "partial_success", accepted_count: 2, rejected_count: 1, results: [
      { item_index: 0, status: "accepted" },
      { item_index: 1, status: "rejected", error_code: "research_id_conflict", retry_directive: "do_not_retry_same_research_id" },
      { item_index: 2, status: "accepted" },
    ] });
    expect(service.snapshot().counts.receipts).toBe(3);
  });

  it("accepts only the remaining two short-term assessment slots and reports exact retry-after", async () => {
    const clock = new MutableClock("2026-08-24T00:00:00Z");
    const service = new TrustLayerService({ clock, secret: "batch-assessment-rate" });
    const issued = await service.issueSyntheticToken("assessment-rate-group");
    for (let i = 0; i < 8; i += 1) expect((await service.executeTool("report_domain_assessment", assessment(uuid(330 + i), `rate${i}.example.com`), { token: issued.token })).ok).toBe(true);
    const result = await service.executeTool("report_domain_assessments_batch", batch(
      assessment(uuid(340), "rate8.example.com"),
      assessment(uuid(341), "rate9.example.com"),
      assessment(uuid(342), "rate10.example.com"),
    ), { token: issued.token });
    expect(result).toMatchObject({ ok: true, accepted_count: 2, rejected_count: 1, results: [
      { status: "accepted" }, { status: "accepted" },
      { status: "rejected", error_code: "rate_limited", retry_directive: "retry_same_research_id_after_delay", retry_after_seconds: 600 },
    ] });
    expect(service.snapshot().counts.receipts).toBe(10);
  });

  it("rejects every valid duplicate research_id while accepting other unique items", async () => {
    const service = new TrustLayerService({ clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "batch-duplicates" });
    const issued = await service.issueSyntheticToken("duplicate-group");
    const duplicate = assessment(uuid(350), "duplicate.example.com");
    const result = await service.executeTool("report_domain_assessments_batch", batch(duplicate, duplicate, assessment(uuid(351), "unique.example.com")), { token: issued.token });
    expect(result).toMatchObject({ ok: true, accepted_count: 1, rejected_count: 2, results: [
      { item_index: 0, error_code: "duplicate_research_id_in_batch" },
      { item_index: 1, error_code: "duplicate_research_id_in_batch" },
      { item_index: 2, status: "accepted" },
    ] });
    expect(service.snapshot().counts.receipts).toBe(1);
    const invalidUuid = { ...duplicate, research_id: "not-a-v4-uuid" };
    const invalidResult = await service.executeTool("report_domain_assessments_batch", batch(invalidUuid, invalidUuid), { token: issued.token });
    expect(invalidResult).toMatchObject({ ok: true, rejected_count: 2, results: [
      { error_code: "invalid_schema" }, { error_code: "invalid_schema" },
    ] });
  });

  it("localizes item schema failures and does not reflect invalid candidate values", async () => {
    const service = new TrustLayerService({ clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "batch-item-schema" });
    const issued = await service.issueSyntheticToken("item-schema-group");
    const invalidItems = [
      { ...assessment(uuid(360), "bad enum.example.com"), outcome: "bad" },
      { ...assessment(uuid(361), "bad-domain.example.com"), domain: "not a domain" },
      { ...assessment(uuid(362), "bad-uuid.example.com"), research_id: "11111111-1111-3111-8111-111111111111" },
      { ...assessment(uuid(363), "unknown-key.example.com"), unexpected: "do-not-reflect" },
      { research_id: uuid(364) },
      "not-an-object",
    ];
    const result = await service.executeTool("report_domain_assessments_batch", batch(assessment(uuid(365), "valid-neighbor.example.com"), ...invalidItems.slice(0, 4)), { token: issued.token });
    expect(result).toMatchObject({ ok: true, accepted_count: 1, rejected_count: 4 });
    expect(result).not.toHaveProperty("do-not-reflect");
    expect((result as unknown as { results: Array<Record<string, unknown>> }).results.slice(1).every((item) => item.error_code === "invalid_schema")).toBe(true);
    const remainingInvalid = await service.executeTool("report_domain_assessments_batch", batch(...invalidItems.slice(4)), { token: issued.token });
    expect(remainingInvalid).toMatchObject({ ok: true, accepted_count: 0, rejected_count: 2, results: [{ error_code: "invalid_schema" }, { error_code: "invalid_schema" }] });
    expect(service.snapshot().counts.receipts).toBe(1);
  });

  it("accepts and persists guidance_version on assessments and completed manifests", async () => {
    const database = new PostgresCompatDatabase();
    const service = new TrustLayerService({ database, clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "guidance-persist" });
    const issued = await service.issueSyntheticToken("guidance-group");
    const taggedAssessment = assessment(uuid(92), "assessment.example.com", "custom.v2:prompt_7");
    expect(mcpInputAccepts("report_domain_assessment", taggedAssessment)).toBe(true);
    expect(await service.executeTool("report_domain_assessment", taggedAssessment, { token: issued.token })).toMatchObject({ ok: true });
    const firstManifestBatch = manifest(uuid(93), 1, 2, false, [source("s1")], 2, "skill-2026.08");
    const finalManifestBatch = manifest(uuid(93), 2, 2, true, [source("s2")], 2, "skill-2026.08");
    expect(mcpInputAccepts("report_research_manifest", firstManifestBatch)).toBe(true);
    expect(await service.executeTool("report_research_manifest", firstManifestBatch, { token: issued.token })).toMatchObject({ ok: true });
    expect(await service.executeTool("report_research_manifest", finalManifestBatch, { token: issued.token })).toMatchObject({ ok: true });
    expect(database.db.public.many("SELECT guidance_version FROM assessment_event_receipts")).toEqual([{ guidance_version: "custom.v2:prompt_7" }, { guidance_version: "skill-2026.08" }]);
    expect(database.db.public.many("SELECT guidance_version FROM research_manifests")).toEqual([{ guidance_version: "skill-2026.08" }]);
  });

  it("preserves guidance_version on batch receipts without changing aggregate semantics", async () => {
    const tagged = new TrustLayerService({ database: new PostgresCompatDatabase(), clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "batch-guidance-tagged" });
    const untagged = new TrustLayerService({ clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "batch-guidance-untagged" });
    const taggedToken = await tagged.issueSyntheticToken("batch-guidance-group");
    const untaggedToken = await untagged.issueSyntheticToken("batch-guidance-group");
    const taggedItem = assessment(uuid(415), "batch-guidance.example.com", "batch-guide.v1");
    const untaggedItem = assessment(uuid(415), "batch-guidance.example.com");
    expect(await tagged.executeTool("report_domain_assessments_batch", batch(taggedItem), { token: taggedToken.token })).toMatchObject({ ok: true, accepted_count: 1 });
    expect(await untagged.executeTool("report_domain_assessments_batch", batch(untaggedItem), { token: untaggedToken.token })).toMatchObject({ ok: true, accepted_count: 1 });
    expect(tagged.snapshot().aggregates["batch-guidance.example.com"]).toEqual(untagged.snapshot().aggregates["batch-guidance.example.com"]);
    const taggedDatabase = tagged.database as PostgresCompatDatabase;
    expect(taggedDatabase.db.public.many("SELECT guidance_version FROM assessment_event_receipts")).toEqual([{ guidance_version: "batch-guide.v1" }]);
  });

  it("accepts omitted guidance_version and persists SQL NULL", async () => {
    const database = new PostgresCompatDatabase();
    const service = new TrustLayerService({ database, clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "guidance-null" });
    const issued = await service.issueSyntheticToken("guidance-null-group");
    expect(await service.executeTool("report_domain_assessment", assessment(uuid(94)), { token: issued.token })).toMatchObject({ ok: true });
    expect(await service.executeTool("report_research_manifest", manifest(uuid(95), 1, 1, true, [source("s1")]), { token: issued.token })).toMatchObject({ ok: true });
    expect(database.db.public.many("SELECT guidance_version FROM assessment_event_receipts")).toEqual([{ guidance_version: null }, { guidance_version: null }]);
    expect(database.db.public.many("SELECT guidance_version FROM research_manifests")).toEqual([{ guidance_version: null }]);
  });

  it("rejects invalid guidance_version values in both request schemas and strict MCP validators", () => {
    const service = new TrustLayerService({ dbFile: null, secret: "guidance-schema" });
    for (const guidance_version of ["a".repeat(65), "prompt/v1"]) {
      const invalidAssessment = assessment(uuid(96), "example.com", guidance_version);
      const invalidManifest = manifest(uuid(97), 1, 1, true, [source("s1")], 1, guidance_version);
      expect(service.catalog.validateInput("report_domain_assessment", invalidAssessment).valid).toBe(false);
      expect(service.catalog.validateInput("report_research_manifest", invalidManifest).valid).toBe(false);
      expect(mcpInputAccepts("report_domain_assessment", invalidAssessment)).toBe(false);
      expect(mcpInputAccepts("report_research_manifest", invalidManifest)).toBe(false);
    }
  });

  it("enforces guidance_version boundaries while accepting every allowed character", () => {
    const service = new TrustLayerService({ dbFile: null, secret: "guidance-boundary" });
    for (const guidance_version of ["a", "a".repeat(64), "A09-_:.custom"]) {
      const validAssessment = assessment(uuid(110), "example.com", guidance_version);
      const validManifest = manifest(uuid(111), 1, 1, true, [source("s1")], 1, guidance_version);
      expect(service.catalog.validateInput("report_domain_assessment", validAssessment).valid).toBe(true);
      expect(service.catalog.validateInput("report_research_manifest", validManifest).valid).toBe(true);
    }
    for (const guidance_version of ["", "日本語-v1", "prompt/v1", "prompt v1"]) {
      const invalidAssessment = assessment(uuid(112), "example.com", guidance_version);
      expect(service.catalog.validateInput("report_domain_assessment", invalidAssessment).valid).toBe(false);
    }
  });

  it("rejects a guidance_version change between manifest batches", async () => {
    const service = new TrustLayerService({ clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "guidance-consistency" });
    const issued = await service.issueSyntheticToken("guidance-consistency-group");
    expect(await service.executeTool("report_research_manifest", manifest(uuid(113), 1, 2, false, [source("s1")], 2, "skill:v1"), { token: issued.token })).toMatchObject({ ok: true });
    expect(await service.executeTool("report_research_manifest", manifest(uuid(113), 2, 2, true, [source("s2")], 2, "skill:v2"), { token: issued.token })).toMatchObject({ ok: false, code: "research_id_conflict" });
  });

  it("keeps site aggregates identical when only guidance_version differs", async () => {
    const withGuidance = new TrustLayerService({ clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "guidance-aggregate-with" });
    const withoutGuidance = new TrustLayerService({ clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "guidance-aggregate-without" });
    const taggedToken = await withGuidance.issueSyntheticToken("aggregate-guidance-group");
    const untaggedToken = await withoutGuidance.issueSyntheticToken("aggregate-guidance-group");
    await withGuidance.executeTool("report_domain_assessment", assessment(uuid(98), "aggregate.example.com", "prompt.v1"), { token: taggedToken.token });
    await withoutGuidance.executeTool("report_domain_assessment", assessment(uuid(98), "aggregate.example.com"), { token: untaggedToken.token });
    expect(withGuidance.snapshot().aggregates["aggregate.example.com"]).toEqual(withoutGuidance.snapshot().aggregates["aggregate.example.com"]);
  });

  it("restores HMAC-only participant state from the local test restart bridge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trust-layer-db-"));
    const filePath = join(dir, "state.json");
    try {
      const clock = new MutableClock("2026-08-24T00:00:00Z");
      const first = new TrustLayerService({ dbFile: filePath, clock, secret: "persist-test" });
      const issued = await first.issueSyntheticToken("persisted-group");
      expect(await first.executeTool("report_domain_assessment", assessment(uuid(91)), { token: issued.token })).toMatchObject({ ok: true });
      expect(readFileSync(filePath, "utf8")).not.toContain(issued.token);
      const second = new TrustLayerService({ dbFile: filePath, clock, secret: "persist-test" });
      expect(await second.executeTool("lookup_domain_signal", { domain: "example.com" }, { token: issued.token })).toMatchObject({ ok: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("validates success and error outputs for each registered tool", async () => {
    const service = new TrustLayerService({ clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "contract-test" });
    const issued = await service.issueSyntheticToken("contract-group");
    const assessmentInput = assessment(uuid(100));
    const assessmentSuccess = await service.executeTool("report_domain_assessment", assessmentInput, { token: issued.token });
    expect(assessmentSuccess.ok).toBe(true);
    expect(service.catalog.validateSuccess("report_domain_assessment", assessmentSuccess).valid).toBe(true);
    const assessmentError = await service.executeTool("report_domain_assessment", { ...assessmentInput, unknown: true }, { token: issued.token });
    expect(service.catalog.validateError(assessmentError).valid).toBe(true);

    const manifestInput = manifest(uuid(101), 1, 1, true, [source("s1")]);
    expect((await service.executeTool("report_research_manifest", manifestInput, { token: issued.token })).ok).toBe(true);
    const verificationInput = { attestation_schema_version: "0.1" as const, research_id: uuid(101), verification_mode: "local_byo_api" as const, rubric_version: "0.3" as const, checked_source_refs: ["s1"], result: "consistent" as const, result_codes: ["primary_source_found" as const], alternative_source_refs: [], client_verifier_version: "0.1" as const };
    expect((await service.executeTool("submit_local_verification", verificationInput, { token: issued.token })).ok).toBe(true);
    expect((await service.executeTool("lookup_domain_signal", { domain: "example.com" }, { token: issued.token })).ok).toBe(true);
  });

  it("rolls back an entire single-batch manifest when final rate charge fails", async () => {
    const database = new PostgresCompatDatabase();
    const service = new TrustLayerService({ database, clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "transaction-test" });
    const issued = await service.issueSyntheticToken("transaction-group");
    for (let i = 0; i < 10; i += 1) expect((await service.executeTool("report_domain_assessment", assessment(uuid(200 + i), `rate${i}.example.com`), { token: issued.token })).ok).toBe(true);
    expect(await service.executeTool("report_research_manifest", manifest(uuid(220), 1, 1, true, [source("s1")]), { token: issued.token })).toMatchObject({ ok: false, code: "rate_limited" });
    expect(service.snapshot().counts).toMatchObject({ manifests: 0, sourceDecisions: 0, receipts: 10 });
    expect(database.rowCount("research_manifests")).toBe(0);
    expect(database.rowCount("source_decisions")).toBe(0);
  });

  it("handles manifest idempotency, TTL, and group-cap aggregation", async () => {
    const clock = new MutableClock("2026-08-24T00:00:00Z");
    const service = new TrustLayerService({ clock, secret: "test-secret" });
    const issued = await service.issueSyntheticToken("group-a");
    const first = manifest(uuid(3), 1, 2, false, [source("s1")], 2);
    expect(await service.executeTool("report_research_manifest", first, { token: issued.token })).toMatchObject({ ok: true, batch_status: "awaiting_batches" });
    const last = manifest(uuid(3), 2, 2, true, [source("s2")], 2);
    expect(await service.executeTool("report_research_manifest", last, { token: issued.token })).toMatchObject({ ok: true, batch_status: "complete_eligible" });
    expect(await service.executeTool("report_research_manifest", last, { token: issued.token })).toMatchObject({ ok: true, code: "accepted_idempotent" });
    clock.advanceDays(30);
    await service.runRetention();
    expect(service.snapshot().counts.receipts).toBe(0);

    const groupService = new TrustLayerService({ clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "group-test" });
    const left = await groupService.issueSyntheticToken("same-origin");
    const right = await groupService.issueSyntheticToken("same-origin");
    await groupService.executeTool("report_domain_assessment", assessment(uuid(40)), { token: left.token });
    await groupService.executeTool("report_domain_assessment", assessment(uuid(41)), { token: right.token });
    expect(groupService.snapshot().aggregates["example.com"].support).toBeLessThanOrEqual(1);
  });

  it("preserves invalid and duplicate causes when the batch starts cooldown", async () => {
    const service = new TrustLayerService({ clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "batch-cooldown-priority" });
    const issued = await service.issueSyntheticToken("cooldown-priority-group");
    for (let i = 0; i < 4; i += 1) expect((await service.executeTool("report_domain_assessments_batch", batch({}), { token: issued.token })).ok).toBe(true);
    const conflict = assessment(uuid(370), "conflict-priority.example.com");
    const idempotent = assessment(uuid(371), "idempotent-priority.example.com");
    expect(await service.executeTool("report_domain_assessment", conflict, { token: issued.token })).toMatchObject({ ok: true });
    expect(await service.executeTool("report_domain_assessment", idempotent, { token: issued.token })).toMatchObject({ ok: true });
    const result = await service.executeTool("report_domain_assessments_batch", batch(
      {},
      assessment(uuid(372), "duplicate-priority.example.com"),
      assessment(uuid(372), "duplicate-priority.example.com"),
      { ...conflict, outcome: "rejected_or_conflicted" },
      idempotent,
    ), { token: issued.token });
    expect(result).toMatchObject({ ok: true, accepted_count: 0, idempotent_count: 1, rejected_count: 4, results: [
      { error_code: "invalid_schema", retry_directive: "fix_input_then_retry_after_delay", retry_after_seconds: 600 },
      { error_code: "duplicate_research_id_in_batch", retry_directive: "remove_duplicate_then_retry_after_delay", retry_after_seconds: 600 },
      { error_code: "duplicate_research_id_in_batch", retry_directive: "remove_duplicate_then_retry_after_delay", retry_after_seconds: 600 },
      { error_code: "research_id_conflict", retry_directive: "do_not_retry_same_research_id" },
      { status: "accepted_idempotent", rate_charge: "none_idempotent" },
    ] });
    expect(stateOf(service).inputUsage[tokenHashOf(service, issued.token)].cooldownUntil).not.toBeNull();
  });

  it("rate-limits only new items after invalid cooldown, leaving them unpersisted", async () => {
    const service = new TrustLayerService({ clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "batch-new-cooldown" });
    const issued = await service.issueSyntheticToken("new-cooldown-group");
    for (let i = 0; i < 4; i += 1) await service.executeTool("report_domain_assessments_batch", batch({}), { token: issued.token });
    const result = await service.executeTool("report_domain_assessments_batch", batch(
      {},
      assessment(uuid(380), "new-after-cooldown.example.com"),
      assessment(uuid(381), "duplicate-after-cooldown.example.com"),
      assessment(uuid(381), "duplicate-after-cooldown.example.com"),
      {},
    ), { token: issued.token });
    expect(result).toMatchObject({ ok: true, accepted_count: 0, rejected_count: 5, results: [
      { error_code: "invalid_schema", retry_directive: "fix_input_then_retry_after_delay" },
      { error_code: "rate_limited", retry_directive: "retry_same_research_id_after_delay", retry_after_seconds: 600 },
      { error_code: "duplicate_research_id_in_batch", retry_directive: "remove_duplicate_then_retry_after_delay" },
      { error_code: "duplicate_research_id_in_batch", retry_directive: "remove_duplicate_then_retry_after_delay" },
      { error_code: "invalid_schema", retry_directive: "fix_input_then_retry_after_delay" },
    ] });
    expect(service.snapshot().counts.receipts).toBe(0);
  });

  it("charges outer-invalid batches by clamped slot count and preserves the cause", async () => {
    const service = new TrustLayerService({ clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "batch-outer-invalid" });
    const issued = await service.issueSyntheticToken("outer-invalid-group");
    expect(await service.executeTool("report_domain_assessments_batch", {}, { token: issued.token })).toMatchObject({ ok: false, code: "invalid_schema" });
    const six = { assessments: Array.from({ length: 6 }, () => ({})) };
    expect(await service.executeTool("report_domain_assessments_batch", six, { token: issued.token })).toMatchObject({ ok: false, code: "invalid_schema", retry_directive: "fix_request_then_retry_after_delay", retry_after_seconds: 600 });
    const usage = stateOf(service).inputUsage[tokenHashOf(service, issued.token)];
    expect(usage.all).toHaveLength(6);
    expect(usage.invalid).toHaveLength(6);
    expect(usage.cooldownUntil).not.toBeNull();
    expect(await service.executeTool("report_domain_assessments_batch", batch(assessment(uuid(390), "cooldown-blocked.example.com")), { token: issued.token })).toMatchObject({ ok: false, code: "rate_limited", retry_after_seconds: 600 });
  });

  it("reserves input resources atomically by batch slot count", async () => {
    const clock = new MutableClock("2026-08-24T00:00:00Z");
    const batchService = new TrustLayerService({ clock, secret: "input-slot-equivalence" });
    const singleService = new TrustLayerService({ clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "input-slot-equivalence-2" });
    const batchToken = await batchService.issueSyntheticToken("input-slot-group");
    const singleToken = await singleService.issueSyntheticToken("input-slot-group");
    const items = Array.from({ length: 5 }, (_, index) => assessment(uuid(400 + index), `slot${index}.example.com`));
    expect(await batchService.executeTool("report_domain_assessments_batch", batch(...items), { token: batchToken.token })).toMatchObject({ ok: true, accepted_count: 5 });
    for (const item of items) expect(await singleService.executeTool("report_domain_assessment", item, { token: singleToken.token })).toMatchObject({ ok: true });
    expect(stateOf(batchService).inputUsage[tokenHashOf(batchService, batchToken.token)].all).toHaveLength(5);
    expect(stateOf(singleService).inputUsage[tokenHashOf(singleService, singleToken.token)].all).toHaveLength(5);

    const constrained = new TrustLayerService({ clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "input-slot-constrained" });
    const constrainedToken = await constrained.issueSyntheticToken("input-slot-constrained-group");
    const constrainedUsage = stateOf(constrained).inputUsage[tokenHashOf(constrained, constrainedToken.token)] ?? { all: [], invalid: [], cooldownUntil: null };
    constrainedUsage.all = Array.from({ length: 26 }, () => "2026-08-24T00:00:00.000Z");
    stateOf(constrained).inputUsage[tokenHashOf(constrained, constrainedToken.token)] = constrainedUsage;
    expect(await constrained.executeTool("report_domain_assessments_batch", batch(...items), { token: constrainedToken.token })).toMatchObject({ ok: false, code: "rate_limited", retry_after_seconds: 600 });
    expect(constrained.snapshot().counts.receipts).toBe(0);
  });

  it("uses the k-th expiration and the maximum of short, long, cooldown, and assessment waits", async () => {
    const clock = new MutableClock("2026-08-24T00:00:00Z");
    const service = new TrustLayerService({ clock, secret: "capacity-retry" });
    const internal = service as unknown as {
      capacityRetryAfter: (timestamps: readonly string[], windowMs: number, limit: number, units: number, now: number) => number | undefined;
      maxRetryAfter: (...values: Array<number | undefined>) => number | undefined;
      assertAssessmentRate: (state: StoreState, tokenHash: string, units?: number) => void;
    };
    const now = clock.now().getTime();
    expect(internal.capacityRetryAfter([new Date(now - 5_000).toISOString(), new Date(now - 4_000).toISOString(), new Date(now - 3_000).toISOString()], 600_000, 3, 2, now)).toBe(596);
    expect(internal.capacityRetryAfter([new Date(now - 5_000).toISOString(), new Date(now - 4_000).toISOString(), new Date(now - 3_000).toISOString()], 86_400_000, 3, 2, now)).toBe(86396);
    expect(internal.maxRetryAfter(undefined, 11, 7)).toBe(11);

    const issued = await service.issueSyntheticToken("capacity-group");
    const tokenHash = tokenHashOf(service, issued.token);
    stateOf(service).assessmentUsage[tokenHash] = Array.from({ length: 10 }, () => new Date(now - 100_000).toISOString());
    expect(() => internal.assertAssessmentRate(stateOf(service), tokenHash, 1)).toThrow();
    try { internal.assertAssessmentRate(stateOf(service), tokenHash, 1); } catch (error) { expect(error).toMatchObject({ code: "rate_limited", retryAfterSeconds: 500 }); }

    const shortTimestamps = [5_000, 4_000, 3_000, 2_000, 1_000].map((age) => new Date(now - age).toISOString())
      .concat(Array.from({ length: 25 }, () => new Date(now - 500).toISOString()));
    const longTimestamps = [3_600_005, 3_600_004, 3_600_003, 3_600_002, 3_600_001].map((age) => new Date(now - age).toISOString())
      .concat(Array.from({ length: 265 }, () => new Date(now - 20 * 60_000).toISOString()));
    const usage = { all: [...longTimestamps, ...shortTimestamps], invalid: [], cooldownUntil: new Date(now + 60_000).toISOString() };
    stateOf(service).inputUsage[tokenHash] = usage;
    const inputResourceRetryAfter = (service as unknown as {
      inputResourceRetryAfter: (state: StoreState, tokenHash: string, units: number) => number | undefined;
    }).inputResourceRetryAfter.bind(service);
    expect(internal.capacityRetryAfter(shortTimestamps, 600_000, 30, 5, now)).toBe(599);
    expect(internal.capacityRetryAfter(usage.all, 86_400_000, 300, 5, now)).toBe(82_800);
    expect(inputResourceRetryAfter(stateOf(service), tokenHash, 5)).toBe(82_800);
  });

  it("combines assessment and one-slot input retry-after and allows the documented single-item retry", async () => {
    const clock = new MutableClock("2026-08-24T00:00:00Z");
    const service = new TrustLayerService({ clock, secret: "combined-retry" });
    const issued = await service.issueSyntheticToken("combined-retry-group");
    const tokenHash = tokenHashOf(service, issued.token);
    const now = clock.now().getTime();
    stateOf(service).inputUsage[tokenHash] = { all: Array.from({ length: 29 }, () => new Date(now - 1_000).toISOString()), invalid: [], cooldownUntil: null };
    stateOf(service).assessmentUsage[tokenHash] = Array.from({ length: 10 }, () => new Date(now - 100_000).toISOString());
    const item = assessment(uuid(410), "combined-retry.example.com");
    const rejectedResult = await service.executeTool("report_domain_assessments_batch", batch(item), { token: issued.token });
    expect(rejectedResult).toMatchObject({ ok: true, rejected_count: 1, results: [{ error_code: "rate_limited", retry_after_seconds: 599 }] });
    expect(service.snapshot().counts.receipts).toBe(0);
    clock.advanceMs(599_000);
    expect(await service.executeTool("report_domain_assessments_batch", batch(item), { token: issued.token })).toMatchObject({ ok: true, accepted_count: 1 });
  });

  it("retains only non-business accounting when inner or outer success validation fails", async () => {
    const innerCatalog = new (await import("../src/schemaCatalog.js")).SchemaCatalog();
    const originalInner = innerCatalog.validateSuccess.bind(innerCatalog);
    innerCatalog.validateSuccess = (tool, value) => tool === "report_domain_assessments_batch" ? { valid: false, errors: [] } : originalInner(tool, value);
    const innerService = new TrustLayerService({ clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "inner-validation-failure", catalog: innerCatalog });
    const innerToken = await innerService.issueSyntheticToken("validation-group");
    expect(await innerService.executeTool("report_domain_assessments_batch", batch(assessment(uuid(420), "inner-failure.example.com"), {}), { token: innerToken.token })).toMatchObject({ ok: false, code: "internal_error" });
    expect(innerService.snapshot().counts.receipts).toBe(0);
    expect(stateOf(innerService).inputUsage[tokenHashOf(innerService, innerToken.token)].all).toHaveLength(2);
    expect(stateOf(innerService).inputUsage[tokenHashOf(innerService, innerToken.token)].invalid).toHaveLength(1);

    const outerCatalog = new (await import("../src/schemaCatalog.js")).SchemaCatalog();
    const originalOuter = outerCatalog.validateSuccess.bind(outerCatalog);
    let batchSuccessCalls = 0;
    outerCatalog.validateSuccess = (tool, value) => {
      if (tool === "report_domain_assessments_batch") {
        batchSuccessCalls += 1;
        if (batchSuccessCalls === 2) return { valid: false, errors: [] };
      }
      return originalOuter(tool, value);
    };
    const outerService = new TrustLayerService({ clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "outer-validation-failure", catalog: outerCatalog });
    const outerToken = await outerService.issueSyntheticToken("validation-group");
    expect(await outerService.executeTool("report_domain_assessments_batch", batch(assessment(uuid(421), "outer-failure.example.com")), { token: outerToken.token })).toMatchObject({ ok: false, code: "internal_error" });
    expect(outerService.snapshot().counts.receipts).toBe(0);
    expect(stateOf(outerService).inputUsage[tokenHashOf(outerService, outerToken.token)].all).toHaveLength(1);
  });

  it("does not retain prepared business state when the final replacement throws", async () => {
    const service = new TrustLayerService({ clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "replace-state-failure" });
    const issued = await service.issueSyntheticToken("replace-state-group");
    const internal = service as unknown as { replaceState: (target: StoreState, source: StoreState) => void };
    const originalReplaceState = internal.replaceState.bind(service);
    let replaceStateCalls = 0;
    internal.replaceState = (target, source) => {
      replaceStateCalls += 1;
      if (replaceStateCalls === 2) throw new Error("injected final replacement failure");
      originalReplaceState(target, source);
    };
    expect(await service.executeTool("report_domain_assessments_batch", batch(assessment(uuid(430), "replace-failure.example.com")), { token: issued.token })).toMatchObject({ ok: false, code: "internal_error" });
    expect(replaceStateCalls).toBe(2);
    expect(service.snapshot().counts.receipts).toBe(0);
    expect(service.snapshot().counts.rollups).toBe(0);
    expect(Object.keys(service.snapshot().aggregates)).toHaveLength(0);
    expect(stateOf(service).assessmentUsage[tokenHashOf(service, issued.token)]).toBeUndefined();
    expect(stateOf(service).inputUsage[tokenHashOf(service, issued.token)].all).toHaveLength(1);
  });

  it("clears expired invalid cooldown and distinguishes active from newly-started cooldown", async () => {
    const clock = new MutableClock("2026-08-24T00:00:00Z");
    const service = new TrustLayerService({ clock, secret: "invalid-helper" });
    const issued = await service.issueSyntheticToken("invalid-helper-group");
    const tokenHash = tokenHashOf(service, issued.token);
    const internal = service as unknown as {
      noteInvalidBatchItems: (state: StoreState, tokenHash: string, units: number) => { kind: string; retryAfterSeconds: number } | undefined;
    };
    stateOf(service).inputUsage[tokenHash] = { all: [], invalid: [], cooldownUntil: "2026-08-23T23:50:00.000Z" };
    expect(internal.noteInvalidBatchItems(stateOf(service), tokenHash, 1)).toBeUndefined();
    expect(stateOf(service).inputUsage[tokenHash].cooldownUntil).toBeNull();
    stateOf(service).inputUsage[tokenHash] = { all: [], invalid: [], cooldownUntil: "2026-08-24T00:05:00.000Z" };
    expect(internal.noteInvalidBatchItems(stateOf(service), tokenHash, 1)).toMatchObject({ kind: "existing_active", retryAfterSeconds: 300 });
    stateOf(service).inputUsage[tokenHash] = { all: [], invalid: Array.from({ length: 4 }, () => "2026-08-24T00:00:00.000Z"), cooldownUntil: null };
    expect(internal.noteInvalidBatchItems(stateOf(service), tokenHash, 1)).toMatchObject({ kind: "started", retryAfterSeconds: 600 });
  });
});

describe("positive-state decision boundaries", () => {
  it("requires 11 full groups for LOO mass, then stage 1 keeps the positive state disabled", async () => {
    const tenClock = new MutableClock("2026-08-24T00:00:00Z");
    const tenGroupService = new TrustLayerService({ clock: tenClock, secret: "positive-ten-groups", stage: 2 });
    for (let index = 0; index < 10; index += 1) {
      const issued = await issueEligibleToken(tenGroupService, tenClock, `ten-origin-${index}`, index);
      await submitSupport(tenGroupService, issued.token, 2_000 + index, index % 2 === 0 ? "openai_gpt5" : "anthropic_claude4");
    }
    const tenAggregate = tenGroupService.snapshot().aggregates["example.com"];
    expect(tenAggregate).toMatchObject({ decisive: 10, groupCount: 10, state: "review_hold", stateReason: "fragile_to_group_removal" });
    expect(tenAggregate.maxGroupShare).toBeCloseTo(0.1, 10);
    expect(tenAggregate.state).not.toBe("consistent_support");

    const elevenClock = new MutableClock("2026-08-24T00:00:00Z");
    const elevenGroupService = new TrustLayerService({ clock: elevenClock, secret: "positive-eleven-groups", stage: 1 });
    expect(elevenGroupService.stage).toBe(1);
    for (let index = 0; index < 11; index += 1) {
      const issued = await issueEligibleToken(elevenGroupService, elevenClock, `eleven-origin-${index}`, index + 20);
      await submitSupport(elevenGroupService, issued.token, 3_000 + index, index % 2 === 0 ? "openai_gpt5" : "anthropic_claude4");
    }
    const elevenAggregate = elevenGroupService.snapshot().aggregates["example.com"];
    expect(elevenAggregate).toMatchObject({ decisive: 11, groupCount: 11, state: "review_hold", stateReason: "stage1_positive_state_disabled" });
    expect(elevenAggregate.state).not.toBe("consistent_support");
    const lookup = await elevenGroupService.executeTool("lookup_domain_signal", { domain: "example.com" }, { token: (await elevenGroupService.issueSyntheticToken("lookup-only")).token });
    expect(lookup).toMatchObject({ ok: true, state: "review_hold", state_reason: "stage1_positive_state_disabled" });
    expect(elevenGroupService.catalog.validateSuccess("lookup_domain_signal", lookup).valid).toBe(true);
  }, 90_000);

  it("keeps cross-group family diversity invariant under rollup insertion order", async () => {
    const domain = "order-invariant.example.com";
    const buildAggregate = async (order: Array<[string, ModelFamily, number]>) => {
      const service = new TrustLayerService({ clock: new MutableClock("2026-08-24T00:00:00Z"), secret: `order-${order.map(([, , id]) => id).join("-")}` });
      await service.initialize();
      const internal = service as unknown as {
        addRollup: (state: StoreState, receipt: Receipt, mode: "minimal" | "manifest") => void;
        recomputeDomain: (state: StoreState, domain: string) => { crossGroupFamilyDiversity: boolean };
      };
      const state = stateOf(service);
      state.sites[domain] = { domain, firstObservedAt: "2026-08-24T00:00:00.000Z" };
      for (const [group, family, id] of order) {
        internal.addRollup(state, {
          receiptId: `r-${id}`, researchId: uuid(5_000 + id), domain, outcome: "used_as_support", reasonCode: "direct_evidence",
          rubricVersion: "0.3", tokenHash: `token-${id}`, provenanceGroupHash: group,
          modelName: family === "openai" ? "openai_gpt5" : "anthropic_claude4", modelFamily: family,
          appliedWeight: 1, observedAt: "2026-08-24T00:00:00.000Z", payloadDigest: `digest-${id}`,
        }, "minimal");
      }
      return internal.recomputeDomain(state, domain).crossGroupFamilyDiversity;
    };

    const firstOrder = await buildAggregate([["g1", "openai", 1], ["g1", "anthropic", 2], ["g2", "anthropic", 3]]);
    const secondOrder = await buildAggregate([["g2", "anthropic", 3], ["g1", "openai", 1], ["g1", "anthropic", 2]]);
    expect(firstOrder).toBe(true);
    expect(secondOrder).toBe(true);
    expect(secondOrder).toBe(firstOrder);
  });
});
