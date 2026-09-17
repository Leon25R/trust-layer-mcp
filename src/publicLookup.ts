import { isIP } from "node:net";
import { domainToASCII } from "node:url";

export const PUBLIC_CONSENT_VERSION = "public-observation-v1" as const;
export const PUBLIC_CACHE_MAX_ENTRIES = 1024;

export const PUBLIC_SCHEMA_VERSION = "public-domain-signal-v1" as const;
export const PUBLIC_NEXT_CHECKS = ["identify_publisher", "check_date", "check_primary_evidence"] as const;
export const PUBLIC_LIMITATIONS = ["not_a_truth_rating"] as const;
export const PUBLIC_PROJECTION_MAX_AGE_MS = 60_000;

export const PUBLIC_STATS_SCHEMA_VERSION = "public-stats-v1" as const;
export const PUBLIC_STATS_COVERAGE_STARTED_AT = "2026-09-15" as const;
export const PUBLIC_STATS_REFRESH_INTERVAL_MS = 60_000;
export const PUBLIC_STATS_PROJECTION_MAX_AGE_MS = 120_000;
export const PUBLIC_STATS_LIMITATIONS = [
  "aggregated_only",
  "no_domain_enumeration",
  "not_a_truth_rating",
  "groups_do_not_prove_independence",
] as const;
export const PUBLIC_STATS_COUNT_BANDS = ["0", "1-9", "10-49", "50-99", "100+"] as const;
export type PublicStatsCountBand = (typeof PUBLIC_STATS_COUNT_BANDS)[number];

export const PUBLICATION_STATUSES = [
  "no_public_observations",
  "limited_observations",
  "under_review",
  "withdrawn",
] as const;

export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

export interface SourceRoute {
  domain: string;
  official_source_url: string;
  update_history_url: string;
  checked_on: string;
  scope: string;
}

export interface PublicSignalNotice {
  kind: "operator_observation";
  reason_code: "fixed_public_notice";
  scope: string;
  checked_on: string;
}

export interface PublicDomainSignal {
  schema_version: typeof PUBLIC_SCHEMA_VERSION;
  domain: string;
  publication_status: PublicationStatus;
  signal: PublicSignalNotice | null;
  source_routes: SourceRoute[];
  next_checks: [...typeof PUBLIC_NEXT_CHECKS];
  limitations: [...typeof PUBLIC_LIMITATIONS];
}

export interface PublicProjection {
  publication_status: PublicationStatus;
  signal?: PublicSignalNotice | null;
}

/**
 * Deliberately narrow input for the public projection builder.  Passing only
 * these fields makes it difficult for an internal diagnostic to accidentally
 * become part of the anonymous response.
 */
export interface PublicProjectionAggregateInput {
  state: "insufficient" | "consistent_support" | "mixed_observations" | "review_hold" | "withdrawn";
  groupCount: number;
  lastObservedAt: string | null;
}

export interface PublicProjectionRollupInput {
  domain: string;
  provenanceGroupHash: string;
  observedDate: string;
  lastObservedAt: string;
}

export interface PublicProjectionHoldInput {
  publicApproved?: boolean;
  domain: string;
  holdState: "review_hold" | "withdrawn";
  active: boolean;
}

export interface PublicProjectionBuildInput {
  observations?: readonly {
    domain: string;
    principalId: string;
    consentVersion: typeof PUBLIC_CONSENT_VERSION;
    observedDate: string;
    /** Internal-only fields used by the separate stats builder. */
    provenanceGroupHash?: string;
    observedAt?: string;
  }[];
  aggregates: Readonly<Record<string, PublicProjectionAggregateInput>>;
  rollups: readonly PublicProjectionRollupInput[];
  holds: readonly PublicProjectionHoldInput[];
  operatorObservations?: ReadonlyMap<string, PublicSignalNotice>;
}

export interface PublicStatsObservation {
  /** Internal-only. Never copied into a public stats response. */
  domain: string;
  /** Internal-only. Used only to recompute the post-coverage threshold. */
  principalId: string;
  /** Internal-only. Never copied into a public stats response. */
  provenanceGroupHash: string;
  /** Internal-only. Never copied into a public stats response. */
  consentedAt: string;
  observedAt: string;
}

export interface PublicStatsProjectionBuildInput {
  generatedAt: number;
  coverageStartedAt: string;
  acceptedByDate: Readonly<Record<string, number>>;
  observations: readonly PublicStatsObservation[];
}

export interface PublicStatsProjection {
  schema_version: typeof PUBLIC_STATS_SCHEMA_VERSION;
  generated_at: string;
  coverage_started_at: string;
  scope: "active_publicly_consented_minimal_observations";
  metrics: {
    accepted_observations: {
      kind: "cumulative_publicly_consented";
      display_range: PublicStatsCountBand;
    };
    observed_domains: {
      kind: "currently_publicly_qualifying";
      display_range: PublicStatsCountBand;
    };
    provenance_groups: {
      kind: "active_on_publicly_qualifying_domains";
      display_range: PublicStatsCountBand;
    };
  };
  recent_activity: "no_public_activity_yet" | "activity_within_7d" | "no_activity_within_7d";
  limitations: [...typeof PUBLIC_STATS_LIMITATIONS];
}

export interface PublicStatsPublication {
  available: boolean;
  generatedAt: number;
  projection?: PublicStatsProjection;
}

export type PublicStatsProjectionPublisher = (publication: PublicStatsPublication) => void;

export interface PublicProjectionPublication {
  available: boolean;
  generatedAt: number;
  projections: ReadonlyMap<string, PublicProjection>;
  invalidatedDomains: readonly string[];
}

export class PublicDomainValidationError extends Error {
  constructor() {
    super("invalid public domain");
    this.name = "PublicDomainValidationError";
  }
}

export class PublicLookupUnavailableError extends Error {
  constructor() {
    super("public lookup is unavailable");
    this.name = "PublicLookupUnavailableError";
  }
}

function isPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (["localhost", "local", "internal", "invalid", "test", "onion", "home.arpa", "alt"].some((suffix) => lower === suffix || lower.endsWith(`.${suffix}`))) return true;
  const octets = lower.split(".").map(Number);
  if (octets.length !== 4 || !octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) return false;
  return octets[0] === 0
    || octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
}

function isIpLiteral(hostname: string): boolean {
  const withoutBrackets = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return isIP(withoutBrackets) !== 0;
}

/**
 * Normalize only a domain value. This deliberately does not parse or fetch a
 * URL, so path/query data cannot enter the public lookup path.
 */
export function normalizePublicDomain(input: string): string {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim()) throw new PublicDomainValidationError();
  const withoutTrailingDots = input.replace(/\.+$/, "");
  if (withoutTrailingDots.length === 0 || /[\u0000-\u0020/\\:@?#%]/u.test(withoutTrailingDots)) throw new PublicDomainValidationError();
  const ascii = domainToASCII(withoutTrailingDots).toLowerCase();
  if (!ascii || ascii.length > 253 || isIpLiteral(ascii) || isPrivateHost(ascii)) throw new PublicDomainValidationError();
  const labels = ascii.split(".");
  if (labels.length < 2 || labels.some((label) => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))) {
    throw new PublicDomainValidationError();
  }
  return ascii;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function validHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function validateSourceRoutes(value: unknown): SourceRoute[] {
  if (!Array.isArray(value) || value.length > 10) throw new PublicLookupUnavailableError();
  const routes: SourceRoute[] = [];
  const domains = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) throw new PublicLookupUnavailableError();
    const record = candidate as Record<string, unknown>;
    const domain = typeof record.domain === "string" ? normalizePublicDomain(record.domain) : "";
    if (!domain || domains.has(domain)
      || !validHttpsUrl(record.official_source_url)
      || !validHttpsUrl(record.update_history_url)
      || !validDate(record.checked_on)
      || typeof record.scope !== "string" || record.scope.length < 1 || record.scope.length > 500) {
      throw new PublicLookupUnavailableError();
    }
    domains.add(domain);
    routes.push({
      domain,
      official_source_url: record.official_source_url,
      update_history_url: record.update_history_url,
      checked_on: record.checked_on,
      scope: record.scope,
    });
  }
  return routes;
}

function cloneSignal(signal: PublicSignalNotice | null | undefined): PublicSignalNotice | null {
  if (!signal) return null;
  return { kind: signal.kind, reason_code: signal.reason_code, scope: signal.scope, checked_on: signal.checked_on };
}

/** Convert internal aggregate state into the intentionally small public map. */
export function buildPublicProjections(input: PublicProjectionBuildInput): Map<string, PublicProjection> {
  const domains = new Set<string>([
    ...Object.keys(input.aggregates),
    ...(input.observations ?? []).map((observation) => observation.domain),
    ...input.rollups.map((rollup) => rollup.domain),
    ...input.holds.map((hold) => hold.domain),
    ...(input.operatorObservations ? [...input.operatorObservations.keys()] : []),
  ]);
  const projections = new Map<string, PublicProjection>();

  for (const domain of domains) {
    const principals = new Set((input.observations ?? [])
      .filter((observation) => observation.domain === domain && observation.consentVersion === PUBLIC_CONSENT_VERSION
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(observation.principalId)
        && validDate(observation.observedDate))
      .map((observation) => observation.principalId.toLowerCase()));
    const activeHolds = input.holds.filter((hold) => hold.domain === domain && hold.active);
    const withdrawn = activeHolds.some((hold) => hold.holdState === "withdrawn");
    const reviewHold = activeHolds.some((hold) => hold.holdState === "review_hold" && hold.publicApproved === true);
    const operatorSignal = input.operatorObservations?.get(domain);

    let publicationStatus: PublicationStatus = "no_public_observations";
    let signal: PublicSignalNotice | null = null;
    if (withdrawn) {
      publicationStatus = "withdrawn";
      signal = cloneSignal(operatorSignal);
    } else if (operatorSignal) {
      publicationStatus = "under_review";
      signal = cloneSignal(operatorSignal);
    } else if (reviewHold) {
      publicationStatus = "under_review";
    } else if (principals.size >= 3) {
      // limited_observations is an existence statement only.  It intentionally
      // does not depend on support/rejection, posterior, family, or reason.
      publicationStatus = "limited_observations";
    }
    projections.set(domain, { publication_status: publicationStatus, signal });
  }
  return projections;
}

function isPublicStatsCountBand(value: unknown): value is PublicStatsCountBand {
  return typeof value === "string" && (PUBLIC_STATS_COUNT_BANDS as readonly string[]).includes(value);
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sumPublicStatsLedger(acceptedByDate: Readonly<Record<string, number>>, coverageStartedAt: string): number {
  const coverageStart = Date.parse(`${coverageStartedAt}T00:00:00Z`);
  if (!Number.isFinite(coverageStart)) throw new PublicLookupUnavailableError();
  let total = 0;
  for (const [date, count] of Object.entries(acceptedByDate)) {
    const dateMs = Date.parse(`${date}T00:00:00Z`);
    if (!validDate(date) || dateMs < coverageStart || !isFiniteInteger(count) || !Number.isSafeInteger(total + count)) {
      throw new PublicLookupUnavailableError();
    }
    total += count;
  }
  return total;
}

function clonePublicStatsProjection(projection: PublicStatsProjection): PublicStatsProjection {
  return {
    schema_version: projection.schema_version,
    generated_at: projection.generated_at,
    coverage_started_at: projection.coverage_started_at,
    scope: projection.scope,
    metrics: {
      accepted_observations: { ...projection.metrics.accepted_observations },
      observed_domains: { ...projection.metrics.observed_domains },
      provenance_groups: { ...projection.metrics.provenance_groups },
    },
    recent_activity: projection.recent_activity,
    limitations: [...projection.limitations],
  };
}

/** Convert internal stats inputs into the fixed, aggregate-only public contract. */
export function buildPublicStatsProjection(input: PublicStatsProjectionBuildInput): PublicStatsProjection {
  if (!Number.isSafeInteger(input.generatedAt) || input.generatedAt < 0
    || input.coverageStartedAt !== PUBLIC_STATS_COVERAGE_STARTED_AT || !validDate(input.coverageStartedAt)) {
    throw new PublicLookupUnavailableError();
  }
  const coverageStart = Date.parse(`${input.coverageStartedAt}T00:00:00Z`);
  const acceptedCount = sumPublicStatsLedger(input.acceptedByDate, input.coverageStartedAt);
  const principalsByDomain = new Map<string, Set<string>>();
  const provenanceGroupsByDomain = new Map<string, Set<string>>();
  let latestObservedAt: number | null = null;
  const cutoff = input.generatedAt - 7 * 86_400_000;

  for (const observation of input.observations) {
    if (typeof observation.domain !== "string" || observation.domain.length === 0
      || typeof observation.principalId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(observation.principalId)
      || typeof observation.provenanceGroupHash !== "string" || observation.provenanceGroupHash.length === 0) {
      throw new PublicLookupUnavailableError();
    }
    const observedAt = Date.parse(observation.observedAt);
    const consentedAt = Date.parse(observation.consentedAt);
    if (!Number.isFinite(observedAt) || !Number.isFinite(consentedAt)
      || observedAt > input.generatedAt || consentedAt > input.generatedAt) throw new PublicLookupUnavailableError();
    // Coverage is an inclusion boundary for every stats metric. In
    // particular, a legacy consent must not influence current domains,
    // groups, or recent activity merely because it is still retained.
    if (observedAt < coverageStart || consentedAt < coverageStart) continue;
    const principals = principalsByDomain.get(observation.domain) ?? new Set<string>();
    principals.add(observation.principalId.toLowerCase());
    principalsByDomain.set(observation.domain, principals);
    const groups = provenanceGroupsByDomain.get(observation.domain) ?? new Set<string>();
    groups.add(observation.provenanceGroupHash);
    provenanceGroupsByDomain.set(observation.domain, groups);
    // Activity is intentionally independent of the three-principal domain
    // publication threshold. A consented observation on a thin domain still
    // demonstrates that public activity occurred.
    if (latestObservedAt === null || observedAt > latestObservedAt) latestObservedAt = observedAt;
  }

  // Recompute the public threshold from the coverage-scoped observations.
  // The domain-signal projection intentionally covers a wider lifetime and
  // must not let pre-coverage principals qualify a current stats domain.
  const qualifyingDomains = new Set<string>([...
    principalsByDomain.entries(),
  ].filter(([, principals]) => principals.size >= 3).map(([domain]) => domain));
  const provenanceGroups = new Set<string>();
  for (const domain of qualifyingDomains) {
    for (const group of provenanceGroupsByDomain.get(domain) ?? []) provenanceGroups.add(group);
  }

  const recentActivity = acceptedCount === 0
    ? "no_public_activity_yet"
    : latestObservedAt !== null && latestObservedAt >= cutoff
      ? "activity_within_7d"
      : "no_activity_within_7d";
  return {
    schema_version: PUBLIC_STATS_SCHEMA_VERSION,
    generated_at: new Date(input.generatedAt).toISOString(),
    coverage_started_at: input.coverageStartedAt,
    scope: "active_publicly_consented_minimal_observations",
    metrics: {
      accepted_observations: { kind: "cumulative_publicly_consented", display_range: countBand(acceptedCount) },
      observed_domains: { kind: "currently_publicly_qualifying", display_range: countBand(qualifyingDomains.size) },
      provenance_groups: { kind: "active_on_publicly_qualifying_domains", display_range: countBand(provenanceGroups.size) },
    },
    recent_activity: recentActivity,
    limitations: [...PUBLIC_STATS_LIMITATIONS],
  };
}

export function countBand(value: number): PublicStatsCountBand {
  if (!isFiniteInteger(value)) throw new PublicLookupUnavailableError();
  if (value === 0) return "0";
  if (value < 10) return "1-9";
  if (value < 50) return "10-49";
  if (value < 100) return "50-99";
  return "100+";
}

/**
 * Re-encode a stats projection into the fixed public shape. This is also the
 * final boundary for custom/internal builders: unknown fields are discarded.
 */
export function sanitizePublicStatsProjection(value: unknown): PublicStatsProjection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PublicLookupUnavailableError();
  const record = value as Record<string, unknown>;
  const metrics = record.metrics;
  if (record.schema_version !== PUBLIC_STATS_SCHEMA_VERSION || typeof record.generated_at !== "string"
    || !validDate(record.coverage_started_at) || record.scope !== "active_publicly_consented_minimal_observations"
    || (record.recent_activity !== "no_public_activity_yet" && record.recent_activity !== "activity_within_7d" && record.recent_activity !== "no_activity_within_7d")
    || !Array.isArray(record.limitations) || record.limitations.length !== PUBLIC_STATS_LIMITATIONS.length
    || record.limitations.some((item, index) => item !== PUBLIC_STATS_LIMITATIONS[index])
    || typeof metrics !== "object" || metrics === null || Array.isArray(metrics)) {
    throw new PublicLookupUnavailableError();
  }
  const metricRecord = metrics as Record<string, unknown>;
  const readMetric = (key: string, kind: string): { kind: string; display_range: PublicStatsCountBand } => {
    const metric = metricRecord[key];
    if (typeof metric !== "object" || metric === null || Array.isArray(metric)) throw new PublicLookupUnavailableError();
    const candidate = metric as Record<string, unknown>;
    if (candidate.kind !== kind || !isPublicStatsCountBand(candidate.display_range)) throw new PublicLookupUnavailableError();
    return { kind, display_range: candidate.display_range };
  };
  const generatedAt = Date.parse(record.generated_at);
  if (!Number.isFinite(generatedAt) || new Date(generatedAt).toISOString() !== record.generated_at) throw new PublicLookupUnavailableError();
  return {
    schema_version: PUBLIC_STATS_SCHEMA_VERSION,
    generated_at: record.generated_at,
    coverage_started_at: record.coverage_started_at as string,
    scope: "active_publicly_consented_minimal_observations",
    metrics: {
      accepted_observations: readMetric("accepted_observations", "cumulative_publicly_consented") as PublicStatsProjection["metrics"]["accepted_observations"],
      observed_domains: readMetric("observed_domains", "currently_publicly_qualifying") as PublicStatsProjection["metrics"]["observed_domains"],
      provenance_groups: readMetric("provenance_groups", "active_on_publicly_qualifying_domains") as PublicStatsProjection["metrics"]["provenance_groups"],
    },
    recent_activity: record.recent_activity,
    limitations: [...PUBLIC_STATS_LIMITATIONS],
  };
}

function buildResponse(domain: string, route: SourceRoute | undefined, projection: PublicProjection | undefined): PublicDomainSignal {
  const status = projection?.publication_status ?? "no_public_observations";
  const signal = status === "no_public_observations" || status === "limited_observations"
    ? null
    : cloneSignal(projection?.signal);
  return {
    schema_version: PUBLIC_SCHEMA_VERSION,
    domain,
    publication_status: status,
    signal,
    source_routes: route ? [{ ...route }] : [],
    next_checks: [...PUBLIC_NEXT_CHECKS],
    limitations: [...PUBLIC_LIMITATIONS],
  };
}

export class PublicLookup {
  private readonly routesByDomain: Map<string, SourceRoute>;
  private projections = new Map<string, PublicProjection>();
  private readonly cache = new Map<string, { expiresAt: number; value: PublicDomainSignal }>();
  private readonly cacheTtlMs: number;
  private readonly projectionMaxAgeMs: number;
  private readonly nowProvider: () => number;
  private projectionAvailable = true;
  private projectionGeneratedAt: number | null = null;
  private projectionFreshnessEnforced = false;

  constructor(
    sourceRoutes: SourceRoute[] = [],
    projections: ReadonlyMap<string, PublicProjection> = new Map(),
    cacheTtlMs = 60_000,
    projectionMaxAgeMs = PUBLIC_PROJECTION_MAX_AGE_MS,
    nowProvider: () => number = Date.now,
    private readonly maxCacheEntries = PUBLIC_CACHE_MAX_ENTRIES,
  ) {
    if (!Number.isInteger(maxCacheEntries) || maxCacheEntries < 1) throw new Error("invalid cache capacity");
    this.routesByDomain = new Map(sourceRoutes.map((route) => [route.domain, { ...route }]));
    this.cacheTtlMs = cacheTtlMs;
    this.projectionMaxAgeMs = projectionMaxAgeMs;
    this.nowProvider = nowProvider;
    // Preserve the original constructor-injected Map contract for callers
    // outside the writer/server path. The service publisher explicitly opts
    // this instance into freshness enforcement below.
    this.projections = new Map([...projections].map(([domain, projection]) => [domain, {
      publication_status: projection.publication_status,
      signal: cloneSignal(projection.signal),
    }]));
    this.projectionGeneratedAt = this.nowProvider();
  }

  applyProjectionPublication(publication: PublicProjectionPublication): void {
    this.projectionFreshnessEnforced = true;
    if (!publication.available) {
      this.markProjectionUnavailable();
      return;
    }
    this.projections = new Map([...publication.projections].map(([domain, projection]) => [domain, {
      publication_status: projection.publication_status,
      signal: cloneSignal(projection.signal),
    }]));
    this.projectionAvailable = true;
    this.projectionGeneratedAt = publication.generatedAt;
    for (const domain of publication.invalidatedDomains) this.invalidate(domain);
  }

  replaceProjections(projections: ReadonlyMap<string, PublicProjection>, generatedAt = this.nowProvider(), invalidatedDomains: readonly string[] = []): void {
    this.applyProjectionPublication({ available: true, generatedAt, projections, invalidatedDomains });
  }

  markProjectionUnavailable(): void {
    this.projectionAvailable = false;
    this.projectionGeneratedAt = null;
    this.projections.clear();
    this.cache.clear();
  }

  isCached(domainInput: string, now = this.nowProvider()): boolean {
    const domain = normalizePublicDomain(domainInput);
    if (!this.projectionIsFresh(now)) {
      this.cache.delete(domain);
      return false;
    }
    const cached = this.cache.get(domain);
    if (!cached || cached.expiresAt <= now) {
      this.cache.delete(domain);
      return false;
    }
    return true;
  }

  invalidate(domainInput: string): void {
    const domain = normalizePublicDomain(domainInput);
    this.cache.delete(domain);
  }

  lookup(domainInput: string, now = this.nowProvider()): PublicDomainSignal {
    const domain = normalizePublicDomain(domainInput);
    if (!this.projectionIsFresh(now)) throw new PublicLookupUnavailableError();
    this.sweep(now);
    const cached = this.cache.get(domain);
    if (cached && cached.expiresAt > now) {
      this.cache.delete(domain);
      this.cache.set(domain, cached);
      return structuredClone(cached.value) as PublicDomainSignal;
    }
    if (cached) this.cache.delete(domain);
    const route = this.routesByDomain.get(domain);
    const projection = this.projections.get(domain);
    const value = buildResponse(domain, route, projection);
    if (this.cache.size >= this.maxCacheEntries) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(domain, { expiresAt: now + this.cacheTtlMs, value });
    return structuredClone(value) as PublicDomainSignal;
  }

  sweep(now = this.nowProvider()): void {
    for (const [domain, entry] of this.cache) if (entry.expiresAt <= now) this.cache.delete(domain);
  }

  get cacheSize(): number { return this.cache.size; }

  private projectionIsFresh(now: number): boolean {
    if (!this.projectionAvailable || this.projectionGeneratedAt === null) return false;
    if (!this.projectionFreshnessEnforced) return true;
    if (now - this.projectionGeneratedAt > this.projectionMaxAgeMs) {
      this.cache.clear();
      return false;
    }
    return true;
  }
}

export class PublicStatsLookup {
  private projection: PublicStatsProjection | undefined;
  private projectionAvailable = false;
  private projectionGeneratedAt: number | null = null;

  constructor(
    projectionMaxAgeMs = PUBLIC_STATS_PROJECTION_MAX_AGE_MS,
    private readonly nowProvider: () => number = Date.now,
  ) {
    if (!Number.isInteger(projectionMaxAgeMs) || projectionMaxAgeMs < 1) throw new Error("invalid stats projection age");
    this.projectionMaxAgeMs = projectionMaxAgeMs;
  }

  private readonly projectionMaxAgeMs: number;

  applyProjectionPublication(publication: PublicStatsPublication): void {
    if (!publication.available || !publication.projection) {
      this.markProjectionUnavailable();
      return;
    }
    const projection = sanitizePublicStatsProjection(publication.projection);
    if (!Number.isSafeInteger(publication.generatedAt) || publication.generatedAt < 0 || publication.generatedAt !== Date.parse(projection.generated_at)) {
      this.markProjectionUnavailable();
      return;
    }
    this.projection = projection;
    this.projectionAvailable = true;
    this.projectionGeneratedAt = publication.generatedAt;
  }

  replaceProjection(projection: PublicStatsProjection, generatedAt = this.nowProvider()): void {
    this.applyProjectionPublication({ available: true, generatedAt, projection });
  }

  markProjectionUnavailable(): void {
    this.projection = undefined;
    this.projectionAvailable = false;
    this.projectionGeneratedAt = null;
  }

  lookup(now = this.nowProvider()): PublicStatsProjection {
    if (!this.projectionAvailable || this.projection === undefined || this.projectionGeneratedAt === null
      || now - this.projectionGeneratedAt > this.projectionMaxAgeMs) {
      this.markProjectionUnavailable();
      throw new PublicLookupUnavailableError();
    }
    return clonePublicStatsProjection(this.projection);
  }

  isFresh(now = this.nowProvider()): boolean {
    try { this.lookup(now); return true; } catch { return false; }
  }
}

/** Standalone, non-authenticated, non-writing public lookup function. */
export function lookupPublicDomain(domainInput: string, sourceRoutes: SourceRoute[] = []): PublicDomainSignal {
  return new PublicLookup(sourceRoutes).lookup(domainInput);
}
