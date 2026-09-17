import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { AbuseControls, PUBLIC_ADMISSION_LIMIT, PUBLIC_CONCURRENCY_LIMIT, PUBLIC_STATS_RATE_LIMIT } from "../src/abuseControls.js";
import { buildPublicProjections, buildPublicStatsProjection, PublicLookup, PUBLIC_CONSENT_VERSION } from "../src/publicLookup.js";
import type { StoreState } from "../src/types.js";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { MutableClock } from "../src/clock.js";
import { PostgresCompatDatabase } from "../src/db.js";
import { OAuthService } from "../src/oauth.js";
import { createHttpServer } from "../src/server.js";
import { normalizePublicDomain, lookupPublicDomain, PUBLIC_PROJECTION_MAX_AGE_MS, PUBLIC_STATS_COVERAGE_STARTED_AT, PUBLIC_STATS_PROJECTION_MAX_AGE_MS } from "../src/publicLookup.js";
import { TrustLayerService } from "../src/service.js";

class InProcessResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  readonly headers: Record<string, string | string[] | undefined> = {};
  private readonly chunks: Buffer[] = [];

  setHeader(name: string, value: number | string | readonly string[]): void {
    this.headers[name.toLowerCase()] = Array.isArray(value) ? [...value] as string[] : String(value);
  }

  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    this.headersSent = true;
    this.emit("finish");
    return this;
  }

  body(): unknown {
    const body = Buffer.concat(this.chunks).toString("utf8");
    try { return JSON.parse(body); } catch { return body; }
  }
}

async function requestInProcess(
  listener: RequestListener,
  url: string,
  method = "GET",
  body?: unknown,
  remoteAddress = "198.51.100.10",
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: unknown }> {
  const bodyBuffer = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const req = Readable.from(bodyBuffer === undefined ? [] : [bodyBuffer]) as unknown as IncomingMessage;
  Object.assign(req, {
    method,
    url,
    headers: bodyBuffer === undefined ? {} : { "content-type": "application/json", "content-length": String(bodyBuffer.length) },
    socket: { remoteAddress },
  });
  const response = new InProcessResponse();
  await listener(req, response as unknown as ServerResponse);
  return { status: response.statusCode, headers: response.headers, body: response.body() };
}

function responseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected object response");
  return value as Record<string, unknown>;
}

function receiptIdFrom(value: unknown): string {
  const receiptId = responseObject(value).receipt_id;
  if (typeof receiptId !== "string") throw new Error("expected accepted receipt");
  return receiptId;
}

function assessment(researchId: string, domain: string): Record<string, unknown> {
  return {
    research_id: researchId,
    collection_mode: "minimal_observation",
    rubric_version: "0.3",
    domain,
    outcome: "used_as_support",
    reason_code: "direct_evidence",
    agent_model_name: "openai_gpt5",
  };
}

const servers: ReturnType<typeof createHttpServer>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.emit("close"); vi.useRealTimers(); });

function publicServer(service: TrustLayerService): ReturnType<typeof createHttpServer> {
  const oauth = new OAuthService(service.database, {
    publicBaseUrl: "http://localhost",
    issuer: "http://localhost",
    signingSecret: "oauth-public-test-signing-secret-32-chars!",
    operatorUsername: "operator",
    operatorPassword: "operator-password",
  });
  const server = createHttpServer(service, oauth);
  servers.push(server);
  return server;
}

describe("登録不要の公開閲覧API", () => {
  it("未登録と既存だが非公開の少数投稿を同じno_public_observationsとして返す", async () => {
    const service = new TrustLayerService({ dbFile: null, clock: new MutableClock("2026-09-06T00:00:00Z"), secret: "public-lookup-contract" });
    const token = await service.issueSyntheticToken("private-test");
    expect(await service.executeTool("report_domain_assessment", assessment("11111111-1111-4111-8111-111111111111", "private.example.com"), { token: token.token })).toMatchObject({ ok: true });
    const server = publicServer(service);
    const listener = server.listeners("request")[0] as RequestListener;
    const existing = responseObject((await requestInProcess(listener, "/api/public/domain-signal?domain=private.example.com")).body);
    const missing = responseObject((await requestInProcess(listener, "/api/public/domain-signal?domain=never-seen.example.com")).body);
    expect(existing.publication_status).toBe("no_public_observations");
    expect(missing.publication_status).toBe("no_public_observations");
    expect(existing).toEqual(expect.objectContaining({ schema_version: "public-domain-signal-v1", signal: null }));
    expect(missing).toEqual(expect.objectContaining({ schema_version: "public-domain-signal-v1", signal: null }));
    expect(existing).not.toHaveProperty("domain_exists");
    expect(missing).not.toHaveProperty("domain_exists");
  });

  it("公開APIはexecuteToolを通らず、participants/inputUsageを変えない", async () => {
    const database = new PostgresCompatDatabase();
    const saveState = vi.spyOn(database, "saveState");
    const service = new TrustLayerService({ database, secret: "public-read-only-contract" });
    await service.initialize();
    saveState.mockClear();
    const executeTool = vi.spyOn(service, "executeTool");
    const before = structuredClone((service as unknown as { state: unknown }).state);
    const server = publicServer(service);
    const response = await requestInProcess(server.listeners("request")[0] as RequestListener, "/api/public/domain-signal?domain=example.org");
    expect(response.status).toBe(200);
    expect((service as unknown as { state: { participants: unknown; inputUsage: unknown } }).state.participants).toEqual({});
    expect((service as unknown as { state: { participants: unknown; inputUsage: unknown } }).state.inputUsage).toEqual({});
    expect((service as unknown as { state: unknown }).state).toEqual(before);
    expect(executeTool).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled();
  });

  it("writerが集約更新後にprojectionを再生成し、公開基準を満たす投稿をlimited_observationsにする", async () => {
    const clock = new MutableClock("2026-09-06T00:00:00Z");
    const service = new TrustLayerService({ dbFile: null, clock, secret: "public-projection-refresh" });
    const domain = "published.example.com";
    for (let index = 0; index < 3; index += 1) {
      const token = await service.issueSyntheticToken(`public-group-${index}`);
      const receipt = await service.executeTool(
        "report_domain_assessment",
        assessment(`22222222-2222-4222-8222-22222222222${index}`, domain),
        { token: token.token },
      );
      expect(receipt).toMatchObject({ ok: true });
      await service.recordPublicConsent(receiptIdFrom(receipt), randomUUID(), PUBLIC_CONSENT_VERSION);
    }
    clock.advanceMs(86_400_000);
    await service.runRetention();
    const listener = publicServer(service).listeners("request")[0] as RequestListener;
    const response = await requestInProcess(listener, `/api/public/domain-signal?domain=${domain}`);
    expect(response.status).toBe(200);
    expect(responseObject(response.body)).toMatchObject({
      schema_version: "public-domain-signal-v1",
      domain,
      publication_status: "limited_observations",
      signal: null,
    });
  });

  it("1件だけの投稿はprojection接続後もno_public_observationsのままにする", async () => {
    const service = new TrustLayerService({ dbFile: null, clock: new MutableClock("2026-09-06T00:00:00Z"), secret: "public-thin-projection" });
    const token = await service.issueSyntheticToken("only-one-public-group");
    await service.executeTool("report_domain_assessment", assessment("33333333-3333-4333-8333-333333333333", "thin.example.com"), { token: token.token });
    const response = await requestInProcess(publicServer(service).listeners("request")[0] as RequestListener, "/api/public/domain-signal?domain=thin.example.com");
    expect(response.status).toBe(200);
    expect(responseObject(response.body).publication_status).toBe("no_public_observations");
  });

  it("projectionが古い場合は空状態へフォールバックせず503を返す", async () => {
    const clock = new MutableClock("2026-09-06T00:00:00Z");
    const service = new TrustLayerService({ dbFile: null, clock, secret: "public-stale-projection" });
    const listener = publicServer(service).listeners("request")[0] as RequestListener;
    expect((await requestInProcess(listener, "/api/public/domain-signal?domain=stale.example.com")).status).toBe(200);
    clock.advanceMs(PUBLIC_PROJECTION_MAX_AGE_MS + 1);
    const stale = await requestInProcess(listener, "/api/public/domain-signal?domain=stale.example.com");
    expect(stale.status).toBe(503);
    expect(stale.body).toEqual({ error: "service_unavailable" });
  });

  it("projection生成失敗は誤ったno_public_observationsではなく503になる", async () => {
    const service = new TrustLayerService({
      dbFile: null,
      secret: "public-failed-projection",
      publicProjectionBuilder: () => { throw new Error("projection build failed"); },
    });
    const response = await requestInProcess(publicServer(service).listeners("request")[0] as RequestListener, "/api/public/domain-signal?domain=failed.example.com");
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "service_unavailable" });
  });

  it("review_holdとwithdrawn holdは公開cacheを即時に無効化する", async () => {
    const service = new TrustLayerService({ dbFile: null, clock: new MutableClock("2026-09-06T00:00:00Z"), secret: "public-hold-invalidation" });
    const domain = "hold.example.com";
    for (let index = 0; index < 3; index += 1) {
      const token = await service.issueSyntheticToken(`hold-group-${index}`);
      const receipt = await service.executeTool("report_domain_assessment", assessment(`44444444-4444-4444-8444-44444444444${index}`, domain), { token: token.token });
      await service.recordPublicConsent(receiptIdFrom(receipt), randomUUID(), PUBLIC_CONSENT_VERSION);
    }
    (service.clock as MutableClock).advanceMs(86_400_000);
    await service.runRetention();
    const listener = publicServer(service).listeners("request")[0] as RequestListener;
    expect(responseObject((await requestInProcess(listener, `/api/public/domain-signal?domain=${domain}`)).body).publication_status).toBe("limited_observations");
    await service.addHold(domain, "review_hold", "active_objection", null, true);
    expect(responseObject((await requestInProcess(listener, `/api/public/domain-signal?domain=${domain}`)).body).publication_status).toBe("under_review");
    await service.addHold(domain, "withdrawn", "withdrawn_by_correction");
    expect(responseObject((await requestInProcess(listener, `/api/public/domain-signal?domain=${domain}`)).body).publication_status).toBe("withdrawn");
  });

  it("明示的な運営者観測だけがoperator_observationとして固定signalを持ち、内部診断値は漏らさない", async () => {
    const domain = "operator.example.com";
    const service = new TrustLayerService({
      dbFile: null,
      secret: "public-operator-observation",
      publicOperatorObservations: new Map([[domain, {
        kind: "operator_observation",
        reason_code: "fixed_public_notice",
        scope: "operator-confirmed-public-scope",
        checked_on: "2026-09-06",
      }]]),
    });
    const listener = publicServer(service).listeners("request")[0] as RequestListener;
    const response = responseObject((await requestInProcess(listener, `/api/public/domain-signal?domain=${domain}`)).body);
    expect(response).toMatchObject({ publication_status: "under_review", signal: { kind: "operator_observation" } });
    const serialized = JSON.stringify(response);
    for (const forbidden of ["support", "rejection", "decisive", "groupCount", "group_count", "modelDiversity", "model_diversity", "familyCount", "supportRate", "support_rate", "stateReason", "reason_code_internal"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("公開契約は内部の支持率・群数・モデル多様性を返さず、4つのstatusだけを許可する", () => {
    const result = lookupPublicDomain("Example.ORG.");
    expect(result).toMatchObject({ schema_version: "public-domain-signal-v1", domain: "example.org", publication_status: "no_public_observations", signal: null });
    expect(["no_public_observations", "limited_observations", "under_review", "withdrawn"]).toContain(result.publication_status);
    const serialized = JSON.stringify(result);
    for (const forbidden of ["support", "rejection", "decisive", "groupCount", "group_count", "modelDiversity", "model_diversity", "familyCount", "supportRate", "support_rate"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("送信元あたり30回/分を超えた公開照会を429 + Retry-Afterにする", async () => {
    const service = new TrustLayerService({ dbFile: null, secret: "public-rate-limit" });
    const server = publicServer(service);
    const listener = server.listeners("request")[0] as RequestListener;
    const responses = [];
    for (let index = 0; index < 31; index += 1) responses.push(await requestInProcess(listener, "/api/public/domain-signal?domain=rate.example.com", "GET", undefined, "198.51.100.20"));
    expect(responses.slice(0, 30).every((response) => response.status === 200)).toBe(true);
    expect(responses[30].status).toBe(429);
    expect(responses[30].headers["retry-after"]).toBeDefined();
    expect(responses[30].body).toEqual({ error: "rate_limited", retry_after_seconds: expect.any(Number) });
  });

  it("不正なドメイン・IP literal・内部hostを400にし、IDNと末尾ドットは正規化する", async () => {
    expect(normalizePublicDomain("例え.テスト.")).toBe("xn--r8jz45g.xn--zckzah");
    for (const value of ["localhost", "127.0.0.1", "8.8.8.8", "[::1]", "service.local", "service.internal", "https://example.com/path?q=secret", "example.com/path", "-bad.example.com"]) {
      expect(() => normalizePublicDomain(value)).toThrow();
    }
    const service = new TrustLayerService({ dbFile: null, secret: "public-domain-validation" });
    const server = publicServer(service);
    const listener = server.listeners("request")[0] as RequestListener;
    for (const value of ["localhost", "127.0.0.1", "https://example.com/path", "example.com/path"]) {
      const response = await requestInProcess(listener, "/api/public/domain-signal?domain=" + encodeURIComponent(value));
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "invalid_domain" });
    }
    const normalized = responseObject((await requestInProcess(listener, "/api/public/domain-signal?domain=Example.COM.")).body);
    expect(normalized.domain).toBe("example.com");
  });

  it("公開APIにだけ非credential CORSを付け、固定項目feedback以外を受け付けない", async () => {
    const service = new TrustLayerService({ dbFile: null, secret: "public-feedback-contract" });
    const server = publicServer(service);
    const listener = server.listeners("request")[0] as RequestListener;
    const lookup = await requestInProcess(listener, "/api/public/domain-signal?domain=example.org");
    expect(lookup.headers["access-control-allow-origin"]).toBe("*");
    expect(lookup.headers["access-control-allow-credentials"]).toBeUndefined();
    const page = await requestInProcess(listener, "/");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("Trust Layer 公開閲覧");
    const accepted = await requestInProcess(listener, "/api/public/feedback", "POST", { category: "helpful", domain: "example.org" });
    expect(accepted.status).toBe(202);
    expect(accepted.headers["access-control-allow-methods"]).toBe("POST, OPTIONS");
    const rejected = await requestInProcess(listener, "/api/public/feedback", "POST", { category: "helpful", comment: "do not store" });
    expect(rejected.status).toBe(400);
  });
});

describe("公開統計API v1", () => {
  it("exact countではなく固定帯域だけを返し、ドメイン・個別観測・内部診断を含めない", async () => {
    const clock = new MutableClock("2026-09-15T00:00:00Z");
    const service = new TrustLayerService({ dbFile: null, clock, secret: "public-stats-band-contract" });
    const domain = "stats-private.example.com";
    for (let index = 0; index < 12; index += 1) {
      const token = await service.issueSyntheticToken(`stats-group-${index}`);
      const result = await service.executeTool("report_domain_assessment", assessment(randomUUID(), domain), { token: token.token });
      await service.recordPublicConsent(receiptIdFrom(result), randomUUID(), PUBLIC_CONSENT_VERSION);
    }
    clock.advanceMs(DAY);
    await service.runRetention();
    const response = await requestInProcess(publicServer(service).listeners("request")[0] as RequestListener, "/api/public/stats");
    expect(response.status).toBe(200);
    const body = responseObject(response.body);
    expect(Object.keys(body).sort()).toEqual(["coverage_started_at", "generated_at", "limitations", "metrics", "recent_activity", "schema_version", "scope"]);
    expect(body).toMatchObject({
      schema_version: "public-stats-v1",
      coverage_started_at: PUBLIC_STATS_COVERAGE_STARTED_AT,
      scope: "active_publicly_consented_minimal_observations",
      recent_activity: "activity_within_7d",
    });
    expect(body.metrics).toEqual({
      accepted_observations: { kind: "cumulative_publicly_consented", display_range: "10-49" },
      observed_domains: { kind: "currently_publicly_qualifying", display_range: "1-9" },
      provenance_groups: { kind: "active_on_publicly_qualifying_domains", display_range: "10-49" },
    });
    expect(body).not.toHaveProperty("accepted_observations_count");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(domain);
    for (const forbidden of ["support", "rejection", "insufficient", "decisive", "groupCount", "group_count", "principal", "participant", "receipt", "token", "research_id", "model_family", "provenanceGroupHash"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("query parameterを受け付けず、stats専用予約枠で31回目を429にする", async () => {
    const service = new TrustLayerService({ dbFile: null, secret: "public-stats-admission" });
    const listener = publicServer(service).listeners("request")[0] as RequestListener;
    const query = await requestInProcess(listener, "/api/public/stats?domain=secret.example.com");
    expect(query.status).toBe(400);
    expect(query.body).toEqual({ error: "invalid_request" });
    expect(JSON.stringify(query.body)).not.toContain("secret.example.com");
    const optionsWithQuery = await requestInProcess(listener, "/api/public/stats?domain=secret.example.com", "OPTIONS");
    expect(optionsWithQuery.status).toBe(400);
    expect(optionsWithQuery.body).toEqual({ error: "invalid_request" });
    expect(optionsWithQuery.headers["access-control-allow-origin"]).toBe("*");
    const responses = [];
    for (let index = 0; index < PUBLIC_STATS_RATE_LIMIT + 1; index += 1) {
      responses.push(await requestInProcess(listener, "/api/public/stats", "GET", undefined, "198.51.100.88"));
    }
    expect(responses.slice(0, PUBLIC_STATS_RATE_LIMIT).every((response) => response.status === 200)).toBe(true);
    expect(responses[PUBLIC_STATS_RATE_LIMIT]).toMatchObject({ status: 429, body: { error: "rate_limited", retry_after_seconds: expect.any(Number) } });
    expect(responses[PUBLIC_STATS_RATE_LIMIT].headers["retry-after"]).toBeDefined();
  });

  it("coverage開始前の同意・観測はstatsの現在値とrecent activityへ混入しない", async () => {
    const clock = new MutableClock("2026-09-14T00:00:00Z");
    const service = new TrustLayerService({ dbFile: null, clock, secret: "public-stats-coverage-boundary" });
    for (let index = 0; index < 3; index += 1) {
      const token = await service.issueSyntheticToken(`precoverage-group-${index}`);
      const result = await service.executeTool("report_domain_assessment", assessment(randomUUID(), "precoverage.example.com"), { token: token.token });
      await service.recordPublicConsent(receiptIdFrom(result), randomUUID(), PUBLIC_CONSENT_VERSION);
    }
    clock.set("2026-09-16T00:00:00Z");
    await service.runRetention();
    const body = responseObject((await requestInProcess(publicServer(service).listeners("request")[0] as RequestListener, "/api/public/stats")).body);
    expect(body.metrics).toEqual({
      accepted_observations: { kind: "cumulative_publicly_consented", display_range: "0" },
      observed_domains: { kind: "currently_publicly_qualifying", display_range: "0" },
      provenance_groups: { kind: "active_on_publicly_qualifying_domains", display_range: "0" },
    });
    expect(body.recent_activity).toBe("no_public_activity_yet");
    const state = (service as unknown as { state: StoreState }).state;
    expect(Object.values(state.publicConsents ?? {}).every((consent) => consent.statsEligible !== true)).toBe(true);
  });

  it("coverage前後混在時もstatsのdomain/group閾値はcoverage開始後だけで再計算する", async () => {
    const clock = new MutableClock("2026-09-14T00:00:00Z");
    const service = new TrustLayerService({ dbFile: null, clock, secret: "public-stats-mixed-coverage-boundary" });
    const domain = "mixed-coverage.example.com";
    for (let index = 0; index < 3; index += 1) {
      const token = await service.issueSyntheticToken(`mixed-precoverage-group-${index}`);
      const result = await service.executeTool("report_domain_assessment", assessment(randomUUID(), domain), { token: token.token });
      await service.recordPublicConsent(receiptIdFrom(result), randomUUID(), PUBLIC_CONSENT_VERSION);
    }

    clock.set("2026-09-15T00:00:00Z");
    const postCoverageToken = await service.issueSyntheticToken("mixed-postcoverage-group");
    const postCoverageResult = await service.executeTool("report_domain_assessment", assessment(randomUUID(), domain), { token: postCoverageToken.token });
    await service.recordPublicConsent(receiptIdFrom(postCoverageResult), randomUUID(), PUBLIC_CONSENT_VERSION);

    clock.set("2026-09-16T00:00:00Z");
    await service.runRetention();
    const listener = publicServer(service).listeners("request")[0] as RequestListener;
    expect(responseObject((await requestInProcess(listener, `/api/public/domain-signal?domain=${domain}`)).body).publication_status).toBe("limited_observations");
    const body = responseObject((await requestInProcess(listener, "/api/public/stats")).body);
    expect(body.metrics).toEqual({
      accepted_observations: { kind: "cumulative_publicly_consented", display_range: "1-9" },
      observed_domains: { kind: "currently_publicly_qualifying", display_range: "0" },
      provenance_groups: { kind: "active_on_publicly_qualifying_domains", display_range: "0" },
    });
    expect(body.recent_activity).toBe("activity_within_7d");
  });

  it("recent_activityは公開基準未達の同意済み観測も対象にする", async () => {
    const clock = new MutableClock("2026-09-15T00:00:00Z");
    const service = new TrustLayerService({ dbFile: null, clock, secret: "public-stats-recent-independent" });
    const token = await service.issueSyntheticToken("thin-stats-group");
    const result = await service.executeTool("report_domain_assessment", assessment(randomUUID(), "thin-stats.example.com"), { token: token.token });
    await service.recordPublicConsent(receiptIdFrom(result), randomUUID(), PUBLIC_CONSENT_VERSION);
    clock.advanceMs(DAY);
    await service.runRetention();
    const body = responseObject((await requestInProcess(publicServer(service).listeners("request")[0] as RequestListener, "/api/public/stats")).body);
    expect(body.metrics).toMatchObject({
      accepted_observations: { display_range: "1-9" },
      observed_domains: { display_range: "0" },
      provenance_groups: { display_range: "0" },
    });
    expect(body.recent_activity).toBe("activity_within_7d");
  });

  it("legacy stateの匿名stats GETはledgerを初期化・永続化しない", async () => {
    const template = new TrustLayerService({ dbFile: null, secret: "public-stats-legacy-template" });
    const legacy = structuredClone((template as unknown as { state: StoreState }).state);
    delete legacy.publicStatsLedger;
    const database = new PostgresCompatDatabase();
    vi.spyOn(database, "loadState").mockReturnValue(legacy);
    const save = vi.spyOn(database, "saveState");
    const service = new TrustLayerService({ database, secret: "public-stats-read-only-init" });
    const response = await requestInProcess(publicServer(service).listeners("request")[0] as RequestListener, "/api/public/stats");
    expect(response.status).toBe(200);
    expect(save).not.toHaveBeenCalled();
    expect((service as unknown as { state: StoreState }).state.publicStatsLedger).toBeUndefined();
  });

  it("stats builder失敗はdomain-signalの公開projectionを消去しない", async () => {
    const service = new TrustLayerService({
      dbFile: null,
      secret: "public-stats-failure-isolation",
      publicStatsProjectionBuilder: () => { throw new Error("stats builder failure"); },
    });
    const listener = publicServer(service).listeners("request")[0] as RequestListener;
    const domain = await requestInProcess(listener, "/api/public/domain-signal?domain=stable.example.org");
    expect(domain.status).toBe(200);
    expect(responseObject(domain.body).publication_status).toBe("no_public_observations");
    const stats = await requestInProcess(listener, "/api/public/stats");
    expect(stats.status).toBe(503);
    expect(stats.body).toEqual({ error: "service_unavailable" });
  });

  it("全体admissionの429にも公開CORSを付与する", async () => {
    vi.useFakeTimers();
    const service = new TrustLayerService({ dbFile: null, secret: "public-global-admission-cors" });
    const listener = publicServer(service).listeners("request")[0] as RequestListener;
    for (let index = 0; index < 300; index += 1) {
      const response = await requestInProcess(listener, "/api/public/stats", "GET", undefined, `198.51.${Math.floor(index / 256)}.${index % 256}`);
      expect(response.status).toBe(200);
    }
    const limited = await requestInProcess(listener, "/api/public/stats", "GET", undefined, "198.51.2.45");
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: "rate_limited", retry_after_seconds: expect.any(Number) });
    expect(limited.headers["access-control-allow-origin"]).toBe("*");
  });

  it("OPTIONS/405/成功/制限を含めno-storeと非credential CORSを維持する", async () => {
    const service = new TrustLayerService({ dbFile: null, secret: "public-stats-http-contract" });
    const listener = publicServer(service).listeners("request")[0] as RequestListener;
    const samples = [
      await requestInProcess(listener, "/api/public/stats"),
      await requestInProcess(listener, "/api/public/stats", "OPTIONS"),
      await requestInProcess(listener, "/api/public/stats", "DELETE"),
    ];
    expect(samples.map((sample) => sample.status)).toEqual([200, 204, 405]);
    for (const sample of samples) {
      expect(sample.headers["cache-control"]).toBe("no-store");
      expect(sample.headers["access-control-allow-origin"]).toBe("*");
      expect(sample.headers["access-control-allow-credentials"]).toBeUndefined();
    }
  });

  it("unexpected bodyの413でもno-storeと非credential CORSを維持する", async () => {
    const service = new TrustLayerService({ dbFile: null, secret: "public-stats-body-contract" });
    const listener = publicServer(service).listeners("request")[0] as RequestListener;
    const response = await requestInProcess(listener, "/api/public/stats", "GET", { ignored: true });
    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: "invalid_request" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("projectionの生成失敗・鮮度超過はゼロ件へフォールバックせず503にする", async () => {
    const failing = new TrustLayerService({
      dbFile: null,
      secret: "public-stats-builder-failure",
      publicStatsProjectionBuilder: () => { throw new Error("stats builder failure"); },
    });
    const failed = await requestInProcess(publicServer(failing).listeners("request")[0] as RequestListener, "/api/public/stats");
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ error: "service_unavailable" });

    const clock = new MutableClock("2026-09-15T00:00:00Z");
    const service = new TrustLayerService({ dbFile: null, clock, secret: "public-stats-stale" });
    const listener = publicServer(service).listeners("request")[0] as RequestListener;
    expect((await requestInProcess(listener, "/api/public/stats")).status).toBe(200);
    clock.advanceMs(PUBLIC_STATS_PROJECTION_MAX_AGE_MS + 1);
    const stale = await requestInProcess(listener, "/api/public/stats");
    expect(stale.status).toBe(503);
    expect(stale.body).toEqual({ error: "service_unavailable" });
  });

  it("stats projectionは書込みごとに即時再生成せず、60秒境界でだけ再生成する", async () => {
    const clock = new MutableClock("2026-09-16T00:00:00Z");
    const builder = vi.fn(buildPublicStatsProjection);
    const service = new TrustLayerService({ dbFile: null, clock, secret: "public-stats-fixed-cycle", publicStatsProjectionBuilder: builder });
    const listener = publicServer(service).listeners("request")[0] as RequestListener;
    expect((await requestInProcess(listener, "/api/public/stats")).status).toBe(200);
    expect(builder).toHaveBeenCalledTimes(1);
    const token = await service.issueSyntheticToken("fixed-cycle-group");
    const result = await service.executeTool("report_domain_assessment", assessment(randomUUID(), "fixed-cycle.example.com"), { token: token.token });
    await service.recordPublicConsent(receiptIdFrom(result), randomUUID(), PUBLIC_CONSENT_VERSION);
    expect(builder).toHaveBeenCalledTimes(1);
    await service.runRetention();
    expect(builder).toHaveBeenCalledTimes(1);
    clock.advanceMs(60_000);
    await service.runRetention();
    expect(builder).toHaveBeenCalledTimes(2);
  });
});

const DAY = 86_400_000;
async function sharedFixture(database = new PostgresCompatDatabase()) {
  const clock = new MutableClock("2026-09-06T00:00:00Z");
  const service = new TrustLayerService({ database, clock, secret: "public-security-regression", stage: 1 });
  const receipts: string[] = [];
  const tokens: string[] = [];
  for (let i = 0; i < 3; i++) {
    const token = await service.issueSyntheticToken(`group-${i}`, i === 0);
    tokens.push(token.token);
    const result = await service.executeTool("report_domain_assessment", assessment(randomUUID(), "example.org"), { token: token.token });
    receipts.push(receiptIdFrom(result));
  }
  const lookup = new PublicLookup([], new Map(), 60_000, 60_000, () => clock.now().getTime());
  service.attachPublicProjectionPublisher((publication) => lookup.applyProjectionPublication(publication));
  return { service, clock, receipts, tokens, lookup, database };
}
async function consentAll(f: Awaited<ReturnType<typeof sharedFixture>>, principalIds = [randomUUID(), randomUUID(), randomUUID()]) {
  for (let i = 0; i < f.receipts.length; i++) await f.service.recordPublicConsent(f.receipts[i], principalIds[i], PUBLIC_CONSENT_VERSION);
  f.clock.advanceMs(DAY);
  await f.service.runRetention();
}

describe("公開閲覧セキュリティ回帰", () => {
  it("B1: detailConsent/3群/自動stage1 review_holdだけでは公開しない。同意版とprincipalを必須にする", async () => {
    const f = await sharedFixture();
    expect(f.lookup.lookup("example.org").publication_status).toBe("no_public_observations");
    await expect(f.service.recordPublicConsent(f.receipts[0], randomUUID(), "unknown-version")).rejects.toThrow();
    await expect(f.service.recordPublicConsent(f.receipts[0], "group-0", PUBLIC_CONSENT_VERSION)).rejects.toThrow();
    await consentAll(f);
    expect(f.lookup.lookup("example.org").publication_status).toBe("limited_observations");
    await f.service.addHold("example.org", "review_hold", "private-auto-hold");
    expect(f.lookup.lookup("example.org").publication_status).toBe("limited_observations");
    await f.service.addHold("example.org", "review_hold", "human-reviewed", null, true);
    expect(f.lookup.lookup("example.org").publication_status).toBe("under_review");
  });

  it("B1: 同一principalの複数tokenは1票、再割当は拒否し日境界までは公開しない", async () => {
    const f = await sharedFixture();
    const principal = randomUUID();
    await consentAll(f, [principal, principal, randomUUID()]);
    expect(f.lookup.lookup("example.org").publication_status).toBe("no_public_observations");
    await expect(f.service.recordPublicConsent(f.receipts[1], randomUUID(), PUBLIC_CONSENT_VERSION)).rejects.toThrow("binding conflict");
    const token = await f.service.issueSyntheticToken("fourth");
    const result = await f.service.executeTool("report_domain_assessment", assessment(randomUUID(), "example.org"), { token: token.token });
    await f.service.recordPublicConsent(receiptIdFrom(result), randomUUID(), PUBLIC_CONSENT_VERSION);
    expect(f.lookup.lookup("example.org").publication_status).toBe("no_public_observations");
    f.clock.advanceMs(DAY);
    await f.service.runRetention();
    expect(f.lookup.lookup("example.org").publication_status).toBe("limited_observations");
  });

  it("B1: 同意の永続化・再読込・即時撤回・停止・期限切れ。旧snapshotは非公開", async () => {
    const filePath = join(mkdtempSync(join(tmpdir(), "tl-consent-")), "state.json");
    const f = await sharedFixture(new PostgresCompatDatabase({ filePath }));
    await consentAll(f);
    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as StoreState;
    expect(Object.keys(persisted.publicConsents!)).toHaveLength(3);
    const restarted = new TrustLayerService({ database: new PostgresCompatDatabase({ filePath }), clock: f.clock, secret: "public-security-regression" });
    const lookup = new PublicLookup([], new Map(), 60_000, 60_000, () => f.clock.now().getTime());
    restarted.attachPublicProjectionPublisher((publication) => lookup.applyProjectionPublication(publication));
    await restarted.initialize();
    try {
      expect(lookup.lookup("example.org").publication_status).toBe("limited_observations");
      await restarted.revokePublicConsent(f.receipts[0]);
      expect(lookup.lookup("example.org").publication_status).toBe("no_public_observations");
      await f.service.stopSyntheticToken(f.tokens[0]);
      expect(f.lookup.lookup("example.org").publication_status).toBe("no_public_observations");
      f.clock.advanceMs(30 * DAY);
      await f.service.runRetention();
      expect(f.lookup.lookup("example.org").publication_status).toBe("no_public_observations");
      expect(Object.keys((f.service as unknown as { state: StoreState }).state.publicConsents!)).toHaveLength(0);
    } finally { restarted.stopMaintenance(); }
    delete persisted.publicConsents;
    delete persisted.publicPrincipalBindings;
    const legacyDb = new PostgresCompatDatabase();
    vi.spyOn(legacyDb, "loadState").mockReturnValue(persisted);
    const legacy = new TrustLayerService({ database: legacyDb, clock: new MutableClock("2026-09-07T00:00:00Z"), secret: "legacy-consent" });
    const oldLookup = new PublicLookup();
    legacy.attachPublicProjectionPublisher((publication) => oldLookup.applyProjectionPublication(publication));
    await legacy.initialize();
    try { expect(oldLookup.lookup("example.org", Date.parse("2026-09-07" )).publication_status).toBe("no_public_observations"); }
    finally { legacy.stopMaintenance(); }
  });

  it("B1: 公開適格性が欠けるlegacy/manifest receiptを管理用同意でも公開できない", async () => {
    const f = await sharedFixture();
    const state = (f.service as unknown as { state: StoreState }).state;
    delete state.receipts[f.receipts[0]].publicEligible;
    state.receipts[f.receipts[1]].publicEligible = false;
    for (const receipt of f.receipts.slice(0, 2)) await expect(f.service.recordPublicConsent(receipt, randomUUID(), PUBLIC_CONSENT_VERSION)).rejects.toThrow("ineligible");
    expect(f.lookup.lookup("example.org").publication_status).toBe("no_public_observations");
  });

  it("B2: アイドル80秒でも定期writerが公開200を維持し、closeで停止する", async () => {
    vi.useFakeTimers();
    const f = await sharedFixture();
    const server = publicServer(f.service);
    const listener = server.listeners("request")[0] as RequestListener;
    expect((await requestInProcess(listener, "/api/public/domain-signal?domain=example.org")).status).toBe(200);
    const retention = vi.spyOn(f.service, "runRetention");
    for (let i = 0; i < 4; i++) {
      f.clock.advanceMs(20_000);
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(retention).toHaveBeenCalledTimes(4);
    expect((await requestInProcess(listener, "/api/public/domain-signal?domain=example.org")).status).toBe(200);
    server.emit("close");
    await vi.advanceTimersByTimeAsync(40_000);
    expect(retention).toHaveBeenCalledTimes(4);
  });

  it("B2/B3: 遅い保存は直列化され、未commit holdを公開しない", async () => {
    const f = await sharedFixture();
    await consentAll(f);
    let release!: () => void;
    const original = f.database.saveState.bind(f.database);
    const save = vi.spyOn(f.database, "saveState").mockImplementationOnce(async (state) => {
      await new Promise<void>((resolve) => { release = resolve; });
      original(state);
    });
    const pending = f.service.addHold("example.org", "withdrawn", "pending");
    await Promise.resolve(); await Promise.resolve();
    const queued = f.service.runRetention();
    expect(f.lookup.lookup("example.org").publication_status).toBe("limited_observations");
    const attached = new PublicLookup([], new Map(), 60_000, 60_000, () => f.clock.now().getTime());
    f.service.attachPublicProjectionPublisher((publication) => { f.lookup.applyProjectionPublication(publication); attached.applyProjectionPublication(publication); });
    expect(attached.lookup("example.org").publication_status).toBe("limited_observations");
    expect(save).toHaveBeenCalledTimes(1);
    release(); await pending; await queued;
    expect(save).toHaveBeenCalledTimes(2);
    expect(f.lookup.lookup("example.org").publication_status).toBe("withdrawn");
  });

  it("B3: save失敗は503、メモリrollbackし次のrefreshも未保存holdを再公開しない", async () => {
    const f = await sharedFixture();
    await consentAll(f);
    const listener = publicServer(f.service).listeners("request")[0] as RequestListener;
    const save = vi.spyOn(f.database, "saveState").mockImplementationOnce(() => { throw new Error("disk failure"); });
    await expect(f.service.addHold("example.org", "withdrawn", "failed")).rejects.toThrow("disk failure");
    expect((await requestInProcess(listener, "/api/public/domain-signal?domain=example.org")).status).toBe(503);
    expect(Object.values((f.service as unknown as { state: StoreState }).state.holds)).toHaveLength(0);
    save.mockRestore();
    await f.service.runRetention();
    expect(responseObject((await requestInProcess(listener, "/api/public/domain-signal?domain=example.org")).body).publication_status).toBe("limited_observations");
  });

  it("B4: 表記揺れwithdrawal/解除で同じcacheを更新し、不正holdは拒否する", async () => {
    const f = await sharedFixture(); await consentAll(f);
    expect(f.lookup.lookup("example.org").publication_status).toBe("limited_observations");
    await f.service.addHold("Example.ORG.", "withdrawn", "withdrawal");
    expect(f.lookup.lookup("example.org").publication_status).toBe("withdrawn");
    await f.service.releaseHold("EXAMPLE.org..", "withdrawal");
    expect(f.lookup.lookup("example.org").publication_status).toBe("limited_observations");
    for (const domain of ["https://example.org/", "x.localhost", "bad/path"]) {
      await expect(f.service.addHold(domain, "withdrawn", "bad")).rejects.toThrow();
      await expect(f.service.releaseHold(domain, "bad")).rejects.toThrow();
    }
  });

  it("B4: 既存raw holdをロード時に正規化して保存し、壊れたholdはfail closed", async () => {
    const f = await sharedFixture(); await consentAll(f);
    const state = structuredClone((f.service as unknown as { state: StoreState }).state);
    state.holds["Example.ORG.|old"] = { domain: "Example.ORG.", holdState: "withdrawn", reason: "old", startedAt: f.clock.now().toISOString(), releasedAt: null, expiresAt: null };
    const db = new PostgresCompatDatabase();
    vi.spyOn(db, "loadState").mockReturnValue(state);
    const save = vi.spyOn(db, "saveState");
    const service = new TrustLayerService({ database: db, clock: f.clock, secret: "legacy-hold" });
    const lookup = new PublicLookup([], new Map(), 60_000, 60_000, () => f.clock.now().getTime());
    service.attachPublicProjectionPublisher((publication) => lookup.applyProjectionPublication(publication));
    await service.initialize();
    try {
      expect(lookup.lookup("example.org").publication_status).toBe("withdrawn");
      expect(save.mock.calls[0][0].holds["example.org|old"].domain).toBe("example.org");
    } finally { service.stopMaintenance(); }
    state.holds["bad|bad"] = { ...state.holds["example.org|old"], domain: "https://secret.invalid/path" };
    const bad = new TrustLayerService({ database: db, clock: f.clock, secret: "bad-legacy-hold" });
    await expect(bad.initialize()).rejects.toThrow();
  });

  it("B5/B6: 成功/エラー/OPTIONS/過大body/制限すべてno-store、失敗要求もadmission消費", async () => {
    const f = await sharedFixture();
    const listener = publicServer(f.service).listeners("request")[0] as RequestListener;
    const samples = [
      await requestInProcess(listener, "/api/public/domain-signal?domain=example.org"),
      await requestInProcess(listener, "/api/public/domain-signal?domain=bad/path"),
      await requestInProcess(listener, "/api/public/domain-signal", "OPTIONS"),
      await requestInProcess(listener, "/api/public/domain-signal", "DELETE"),
      await requestInProcess(listener, "/api/public/feedback", "POST", { bad: "x".repeat(9000) }),
      await requestInProcess(listener, "/api/public/feedback", "POST", { category: "helpful" }),
    ];
    expect(samples.map((sample) => sample.status)).toEqual([200, 400, 204, 405, 413, 202]);
    for (const sample of samples) expect(sample.headers["cache-control"]).toBe("no-store");
    for (const [index, [url, method, body]] of ([
      ["/api/public/domain-signal", "OPTIONS", undefined],
      ["/api/public/domain-signal?domain=bad/path", "GET", undefined],
      ["/api/public/feedback", "POST", { invalid: true }],
      ["/api/public/feedback", "POST", { invalid: "x".repeat(9000) }],
    ] as const).entries()) {
      let last;
      for (let i = 0; i <= PUBLIC_ADMISSION_LIMIT; i++) last = await requestInProcess(listener, url, method, body, `peer-${index}`);
      expect(last!.status).toBe(429);
      expect(last!.headers["cache-control"]).toBe("no-store");
      expect(last!.headers["retry-after"]).toBeDefined();
    }
  });

  it("B6: source/feedback Mapは容量上限を越えずTTL sweepで空になり、並行枠は一度だけ解放", () => {
    const abuse = new AbuseControls(2, 2);
    const first = abuse.admit("a", 0); const second = abuse.admit("b", 0);
    expect(() => abuse.admit("a", 0)).toThrow();
    expect(() => abuse.admit("c", 0)).toThrow();
    first(); first(); second();
    for (const source of ["a", "b"]) { abuse.reservePublicLookup(source, true, 0); abuse.reserveFeedback(source, 0); }
    expect(() => abuse.reservePublicLookup("c", true, 0)).toThrow();
    expect(() => abuse.reserveFeedback("c", 0)).toThrow();
    expect(abuse.sizes).toEqual({ admissions: 2, lookups: 2, feedback: 2, active: 0 });
    abuse.sweep(DAY);
    expect(abuse.sizes).toEqual({ admissions: 0, lookups: 0, feedback: 0, active: 0 });
    const lookup = new PublicLookup([], new Map(), 10, 60_000, () => 0, 2);
    for (let i = 0; i < 20; i++) lookup.lookup(`domain${i}.org`, 0);
    expect(lookup.cacheSize).toBe(2);
    expect(lookup.isCached("domain0.org", 0)).toBe(false);
    lookup.sweep(10);
    expect(lookup.cacheSize).toBe(0);
  });

  it("B6: bodyを保留した並行要求は32で止まり、切断後は回復する", async () => {
    const f = await sharedFixture();
    const listener = publicServer(f.service).listeners("request")[0] as RequestListener;
    const requests: Readable[] = [];
    const pending: unknown[] = [];
    for (let i = 0; i < PUBLIC_CONCURRENCY_LIMIT; i++) {
      const req = new Readable({ read() {} });
      Object.assign(req, { url: "/api/public/feedback", method: "POST", headers: {}, socket: { remoteAddress: `peer-${i}` } });
      requests.push(req);
      pending.push(listener(req as IncomingMessage, new InProcessResponse() as unknown as ServerResponse));
    }
    expect((await requestInProcess(listener, "/api/public/domain-signal?domain=example.org")).status).toBe(429);
    for (const req of requests) req.emit("aborted");
    await Promise.all(pending);
    expect((await requestInProcess(listener, "/api/public/domain-signal?domain=example.org")).status).toBe(200);
  });

  it("B7/advisory: JSなしの送信経路なし、外部script/self CSP、実行時もhostname/no-storeのみ送る", async () => {
    const f = await sharedFixture();
    const listener = publicServer(f.service).listeners("request")[0] as RequestListener;
    const page = await requestInProcess(listener, "/");
    expect(page.body).not.toMatch(/<form\b|\bname="(?:domain|category)"|type="submit"/i);
    expect(page.body).toContain("<noscript>");
    expect(page.body).toContain('src="/public/app.js"');
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(page.headers["content-security-policy"]).not.toContain("script-src 'unsafe-inline'");
    const script = await requestInProcess(listener, "/public/app.js");
    expect(script.status).toBe(200);
    const handlers: Record<string, () => Promise<void>> = {};
    const nodes = new Map<string, Record<string, unknown>>();
    const node = (id: string) => {
      if (!nodes.has(id)) nodes.set(id, { value: "", addEventListener: (_event: string, handler: () => Promise<void>) => { handlers[id] = handler; }, appendChild() {}, append() {}, replaceChildren() {} });
      return nodes.get(id)!;
    };
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: "service_unavailable" }) });
    runInNewContext(String(script.body), { URL, fetch, document: { getElementById: node, createTextNode: (value: string) => value, createElement: () => node(randomUUID()) } });
    node("domain").value = "https://example.org/private/path?token=secret#fragment";
    await (handlers["lookup-button"] as unknown as (event: unknown) => Promise<void>)({ preventDefault() {} });
    expect(fetch.mock.calls[0][0]).toBe("/api/public/domain-signal?domain=example.org");
    expect(fetch.mock.calls[0][1]).toMatchObject({ cache: "no-store", credentials: "omit" });
    node("feedback-domain").value = "https://example.org/private?secret=1";
    node("feedback-category").value = "helpful";
    await (handlers["feedback-button"] as unknown as (event: unknown) => Promise<void>)({ preventDefault() {} });
    expect(fetch.mock.calls[1][1]).toMatchObject({ cache: "no-store", body: JSON.stringify({ category: "helpful", domain: "example.org" }) });
    for (const host of ["a.localhost", "a.local", "a.internal", "a.home.arpa", "a.onion", "a.invalid", "a.test", "a.alt"]) expect(() => normalizePublicDomain(host)).toThrow();
  });
});


describe("公開同意の保存境界の追加回帰", () => {
  it("B1: 内部aggregateの自動review_hold/fragileは公開under_reviewに変換しない", () => {
    const projections = buildPublicProjections({
      aggregates: { "example.org": { state: "review_hold", groupCount: 100, lastObservedAt: "2026-09-06T00:00:00Z" } },
      rollups: [0, 1, 2].map((i) => ({ domain: "example.org", provenanceGroupHash: String(i), observedDate: "2026-09-06", lastObservedAt: "2026-09-06T00:00:00Z" })),
      holds: [{ domain: "example.org", holdState: "review_hold", active: true }],
    });
    expect(projections.get("example.org")).toEqual({ publication_status: "no_public_observations", signal: null });
  });

  it("B1: sensitive manifestは後でmanifestがTTL削除されても公開同意対象にならない", async () => {
    const f = await sharedFixture();
    const researchId = randomUUID();
    const token = await f.service.issueSyntheticToken("sensitive");
    const result = await f.service.executeTool("report_research_manifest", {
      research_id: researchId, collection_mode: "evidence_manifest", rubric_version: "0.3", agent_model_name: "openai_gpt5",
      question_context: { intent_category: "factual_lookup", claim_scope_tags: ["product_spec"], sensitivity: "sensitive" },
      manifest: { source_count_total: 1, batch_index: 1, batch_count: 1, complete: true,
        sources: [{ source_ref: "s1", url_scope: "domain_only", domain: "example.org", source_disposition: "used_as_support", reason_codes: ["primary_source"], related_source_refs: [], source_type: "primary", published_date_precision: "day" }],
        final_assessment: { domain: "example.org", outcome: "used_as_support", reason_code: "direct_evidence" } },
    }, { token: token.token });
    expect(result).toMatchObject({ ok: true });
    const state = (f.service as unknown as { state: StoreState }).state;
    const receipt = state.receipts[state.receiptByResearchId[researchId]];
    expect(receipt.publicEligible).toBe(false);
    f.clock.advanceMs(15 * DAY);
    await f.service.runRetention();
    expect(f.service.snapshot().counts.manifests).toBe(0);
    await expect(f.service.recordPublicConsent(receipt.receiptId, randomUUID(), PUBLIC_CONSENT_VERSION)).rejects.toThrow("ineligible");
  });

  it("B3: 3人目の同意保存失敗はrefresh/再起動でも公開されず、版付きschema外投稿も拒否", async () => {
    const filePath = join(mkdtempSync(join(tmpdir(), "tl-failed-consent-")), "state.json");
    const f = await sharedFixture(new PostgresCompatDatabase({ filePath }));
    for (const receipt of f.receipts.slice(0, 2)) await f.service.recordPublicConsent(receipt, randomUUID(), PUBLIC_CONSENT_VERSION);
    vi.spyOn(f.database, "saveState").mockImplementationOnce(() => { throw new Error("save failed"); });
    await expect(f.service.recordPublicConsent(f.receipts[2], randomUUID(), PUBLIC_CONSENT_VERSION)).rejects.toThrow("save failed");
    expect(() => f.lookup.lookup("example.org")).toThrow("unavailable");
    f.clock.advanceMs(DAY); await f.service.runRetention();
    expect(f.lookup.lookup("example.org").publication_status).toBe("no_public_observations");
    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as StoreState;
    expect(Object.keys(persisted.publicConsents!)).toHaveLength(2);
    const restarted = new TrustLayerService({ database: new PostgresCompatDatabase({ filePath }), clock: f.clock, secret: "restart-consent" });
    const lookup = new PublicLookup([], new Map(), 60_000, 60_000, () => f.clock.now().getTime());
    restarted.attachPublicProjectionPublisher((publication) => lookup.applyProjectionPublication(publication));
    await restarted.initialize();
    try { expect(lookup.lookup("example.org").publication_status).toBe("no_public_observations"); }
    finally { restarted.stopMaintenance(); }
    expect(await f.service.executeTool("report_domain_assessment", { ...assessment(randomUUID(), "another.org"), public_consent: true }, { token: f.tokens[0] })).toMatchObject({ ok: false, code: "invalid_schema" });
  });
});


describe("定期ジョブの回復とsweep", () => {
  it("B2/B3/B6: 一時保存障害は503にし、次回成功で回復する。無通信中にもsweepする", async () => {
    vi.useFakeTimers();
    const f = await sharedFixture();
    const server = publicServer(f.service);
    const listener = server.listeners("request")[0] as RequestListener;
    await requestInProcess(listener, "/api/public/domain-signal?domain=example.org");
    const sourceSweep = vi.spyOn(AbuseControls.prototype, "sweep");
    const cacheSweep = vi.spyOn(PublicLookup.prototype, "sweep");
    const save = vi.spyOn(f.database, "saveState").mockImplementationOnce(() => { throw new Error("temporary save failure"); });
    try {
      f.clock.advanceMs(20_000); await vi.advanceTimersByTimeAsync(20_000);
      expect(sourceSweep).toHaveBeenCalled();
      expect(cacheSweep).toHaveBeenCalled();
      const failed = await requestInProcess(listener, "/api/public/domain-signal?domain=example.org");
      expect(failed.status).toBe(503);
      expect(failed.headers["cache-control"]).toBe("no-store");
      f.clock.advanceMs(20_000); await vi.advanceTimersByTimeAsync(20_000);
      expect((await requestInProcess(listener, "/api/public/domain-signal?domain=example.org")).status).toBe(200);
      expect(save).toHaveBeenCalledTimes(2);
    } finally { sourceSweep.mockRestore(); cacheSweep.mockRestore(); save.mockRestore(); }
  });
});


describe("既存holdの衝突移行", () => {
  it("B4: raw-onlyのsiteを補い、同じdomain/reasonの撤回期限を短縮せず解除は両方に効く", async () => {
    const f = await sharedFixture();
    const state = structuredClone((f.service as unknown as { state: StoreState }).state);
    const startedAt = f.clock.now().toISOString();
    state.sites["Other.ORG."] = { domain: "Other.ORG.", firstObservedAt: startedAt };
    state.holds["Other.ORG.|old"] = { domain: "Other.ORG.", holdState: "withdrawn", reason: "old", startedAt, releasedAt: null, expiresAt: null };
    state.holds["OTHER.ORG.|old"] = { domain: "OTHER.ORG.", holdState: "withdrawn", reason: "old", startedAt, releasedAt: null, expiresAt: new Date(f.clock.now().getTime() + 1000).toISOString() };
    const database = new PostgresCompatDatabase();
    vi.spyOn(database, "loadState").mockReturnValue(state);
    const service = new TrustLayerService({ database, clock: f.clock, secret: "hold-collision" });
    const lookup = new PublicLookup([], new Map(), 60_000, 60_000, () => f.clock.now().getTime());
    service.attachPublicProjectionPublisher((publication) => lookup.applyProjectionPublication(publication));
    await service.initialize();
    try {
      expect(Object.values((service as unknown as { state: StoreState }).state.holds)).toHaveLength(2);
      expect((service as unknown as { state: StoreState }).state.sites["other.org"]).toBeDefined();
      f.clock.advanceMs(2000); await service.runRetention();
      expect(lookup.lookup("other.org").publication_status).toBe("withdrawn");
      await service.releaseHold("Other.ORG.", "old");
      expect(lookup.lookup("other.org").publication_status).toBe("no_public_observations");
      expect(Object.values((service as unknown as { state: StoreState }).state.holds).every((hold) => hold.releasedAt !== null)).toBe(true);
    } finally { service.stopMaintenance(); }
  });
});
