import { isIP } from "node:net";
import { domainToASCII } from "node:url";

export const PUBLIC_CONSENT_VERSION = "public-observation-v1" as const;
export const PUBLIC_CACHE_MAX_ENTRIES = 1024;

export const PUBLIC_SCHEMA_VERSION = "public-domain-signal-v1" as const;
export const PUBLIC_NEXT_CHECKS = ["identify_publisher", "check_date", "check_primary_evidence"] as const;
export const PUBLIC_LIMITATIONS = ["not_a_truth_rating"] as const;
export const PUBLIC_PROJECTION_MAX_AGE_MS = 60_000;

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
  }[];
  aggregates: Readonly<Record<string, PublicProjectionAggregateInput>>;
  rollups: readonly PublicProjectionRollupInput[];
  holds: readonly PublicProjectionHoldInput[];
  operatorObservations?: ReadonlyMap<string, PublicSignalNotice>;
}

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

/** Standalone, non-authenticated, non-writing public lookup function. */
export function lookupPublicDomain(domainInput: string, sourceRoutes: SourceRoute[] = []): PublicDomainSignal {
  return new PublicLookup(sourceRoutes).lookup(domainInput);
}
