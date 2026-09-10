/** Runtime configuration parsing with no deployment-specific fallback values. */

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function requireSecret(name: string, supplied?: string): string {
  const value = supplied?.trim();
  if (!value) throw new Error(`${name} must be set; startup is fail-closed`);
  if (value === "trust-layer-local-mvp-secret-change-me") {
    throw new Error(`${name} must not use the retired development default`);
  }
  return value;
}

export function parseAllowedOrigins(value: string | undefined): string[] {
  if (!value?.trim()) throw new Error("TRUST_LAYER_ALLOWED_ORIGINS must be set to a non-empty JSON array or CSV allowlist");
  let entries: unknown;
  try {
    entries = JSON.parse(value);
  } catch {
    entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  if (!Array.isArray(entries) || entries.length === 0 || entries.some((entry) => typeof entry !== "string")) {
    throw new Error("TRUST_LAYER_ALLOWED_ORIGINS must be a non-empty list of origin strings");
  }
  const normalized = entries.map((entry) => normalizeOrigin(entry));
  if (new Set(normalized).size !== normalized.length) throw new Error("TRUST_LAYER_ALLOWED_ORIGINS must not contain duplicate origins");
  return normalized;
}

export function normalizeOrigin(value: string): string {
  if (value === "*") throw new Error("wildcard origins are not allowed");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("allowed origins must be valid absolute URLs");
  }
  if (url.origin !== value || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("allowed origins must contain only scheme, host, and optional port");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error("allowed origins must use HTTPS, except explicit loopback HTTP origins");
  }
  return url.origin;
}

export function requireAbsoluteUrl(name: string, supplied: string | undefined, allowLoopbackHttp = false): URL {
  if (!supplied?.trim()) throw new Error(`${name} must be set`);
  let url: URL;
  try {
    url = new URL(supplied);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.username || url.password || url.search || url.hash) throw new Error(`${name} must not include credentials, query, or fragment`);
  if (url.protocol !== "https:" && !(allowLoopbackHttp && url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error(`${name} must use HTTPS outside explicit loopback test/development use`);
  }
  return url;
}
