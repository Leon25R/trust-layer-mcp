const PUBLIC_LOOKUP_WINDOW_MS = 60_000;
const PUBLIC_LOOKUP_LIMIT = 30;
const PUBLIC_CACHE_MISS_WINDOW_MS = 1_000;
const PUBLIC_CACHE_MISS_LIMIT = 5;
const FEEDBACK_DAY_MS = 86_400_000;
const FEEDBACK_LIMIT = 10;
export const PUBLIC_ADMISSION_LIMIT = 60;
export const PUBLIC_SOURCE_CAPACITY = 1024;
export const PUBLIC_CONCURRENCY_LIMIT = 32;
const GLOBAL_ADMISSION_LIMIT = 300;

export class AbuseLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super("public request rate limited");
    this.name = "AbuseLimitError";
  }
}
function prune(timestamps: number[], now: number, windowMs: number): number[] {
  return timestamps.filter((timestamp) => now - timestamp < windowMs);
}
function retryAfter(oldest: number, windowMs: number, now: number): number {
  return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
}

/** Bounded process-local admission. Source keys must come from the socket peer. */
export class AbuseControls {
  private readonly admissionsBySource = new Map<string, number[]>();
  private readonly lookupsBySource = new Map<string, number[]>();
  private readonly feedbackBySource = new Map<string, { day: number; count: number }>();
  private cacheMisses: number[] = [];
  private globalAdmissions: number[] = [];
  private activeRequests = 0;

  constructor(private readonly maxSources = PUBLIC_SOURCE_CAPACITY, private readonly maxConcurrent = PUBLIC_CONCURRENCY_LIMIT) {
    if (!Number.isInteger(maxSources) || maxSources < 1 || !Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error("invalid admission capacity");
  }

  private ensureCapacity(map: ReadonlyMap<string, unknown>, sourceKey: string): void {
    // Refuse new keys while full instead of evicting live counters (which
    // would let churn reset a source's daily feedback/rate quota).
    if (!map.has(sourceKey) && map.size >= this.maxSources) throw new AbuseLimitError(60);
  }

  /** Charge all methods and failures before URL parsing/body work. */
  admit(sourceKey: string, now = Date.now()): () => void {
    this.sweep(now);
    if (this.globalAdmissions.length >= GLOBAL_ADMISSION_LIMIT) throw new AbuseLimitError(1);
    this.globalAdmissions.push(now);
    this.ensureCapacity(this.admissionsBySource, sourceKey);
    const entries = this.admissionsBySource.get(sourceKey) ?? [];
    if (entries.length >= PUBLIC_ADMISSION_LIMIT) throw new AbuseLimitError(retryAfter(entries[0], PUBLIC_LOOKUP_WINDOW_MS, now));
    entries.push(now);
    this.admissionsBySource.set(sourceKey, entries);
    if (this.activeRequests >= this.maxConcurrent) throw new AbuseLimitError(1);
    this.activeRequests += 1;
    let released = false;
    return () => { if (!released) { released = true; this.activeRequests -= 1; } };
  }

  reservePublicLookup(sourceKey: string, cacheHit: boolean, now = Date.now()): void {
    this.sweep(now);
    this.ensureCapacity(this.lookupsBySource, sourceKey);
    const sourceTimestamps = this.lookupsBySource.get(sourceKey) ?? [];
    if (sourceTimestamps.length >= PUBLIC_LOOKUP_LIMIT) throw new AbuseLimitError(retryAfter(sourceTimestamps[0], PUBLIC_LOOKUP_WINDOW_MS, now));
    sourceTimestamps.push(now);
    this.lookupsBySource.set(sourceKey, sourceTimestamps);
    if (cacheHit) return;
    if (this.cacheMisses.length >= PUBLIC_CACHE_MISS_LIMIT) throw new AbuseLimitError(retryAfter(this.cacheMisses[0], PUBLIC_CACHE_MISS_WINDOW_MS, now));
    this.cacheMisses.push(now);
  }

  reserveFeedback(sourceKey: string, now = Date.now()): void {
    this.sweep(now);
    this.ensureCapacity(this.feedbackBySource, sourceKey);
    const day = Math.floor(now / FEEDBACK_DAY_MS);
    const current = this.feedbackBySource.get(sourceKey);
    if (!current) { this.feedbackBySource.set(sourceKey, { day, count: 1 }); return; }
    if (current.count >= FEEDBACK_LIMIT) throw new AbuseLimitError(Math.max(1, Math.ceil(((day + 1) * FEEDBACK_DAY_MS - now) / 1000)));
    current.count += 1;
  }

  sweep(now = Date.now()): void {
    for (const map of [this.admissionsBySource, this.lookupsBySource]) {
      for (const [key, timestamps] of map) {
        const live = prune(timestamps, now, PUBLIC_LOOKUP_WINDOW_MS);
        if (live.length) map.set(key, live); else map.delete(key);
      }
    }
    for (const [key, value] of this.feedbackBySource) if (value.day !== Math.floor(now / FEEDBACK_DAY_MS)) this.feedbackBySource.delete(key);
    this.cacheMisses = prune(this.cacheMisses, now, PUBLIC_CACHE_MISS_WINDOW_MS);
    this.globalAdmissions = prune(this.globalAdmissions, now, 1_000);
  }

  get sizes(): { admissions: number; lookups: number; feedback: number; active: number } {
    return { admissions: this.admissionsBySource.size, lookups: this.lookupsBySource.size, feedback: this.feedbackBySource.size, active: this.activeRequests };
  }
}
export const PUBLIC_LOOKUP_RATE_LIMIT = PUBLIC_LOOKUP_LIMIT;
export const PUBLIC_FEEDBACK_RATE_LIMIT = FEEDBACK_LIMIT;
