import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { requireAbsoluteUrl, requireSecret } from "./config.js";
import type { TrustLayerDatabase } from "./db.js";
import type { OAuthClient, OAuthState } from "./types.js";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60_000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
const TOOL_SCOPE = "trust_layer:tools";
const OFFLINE_SCOPE = "offline_access";

export interface OAuthSettings {
  issuer: string;
  publicBaseUrl: string;
  signingSecret: string;
  operatorUsername: string;
  operatorPassword: string;
  now?: () => Date;
}

export interface OAuthAccessTokenClaims {
  issuer: string;
  audience: string;
  subject: string;
  scope: string[];
  clientId: string;
  expiresAt: number;
  issuedAt: number;
}

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string;
  scope?: string;
  state?: string;
}

export class OAuthRequestError extends Error {
  constructor(public readonly code: string, public readonly description: string, public readonly status = 400) {
    super(description);
    this.name = "OAuthRequestError";
  }
}

function emptyOAuthState(): OAuthState {
  return { clients: {}, authorizationCodes: {}, refreshTokens: {} };
}

function isScope(value: string): boolean { return value === TOOL_SCOPE || value === OFFLINE_SCOPE; }
function b64url(value: Buffer): string { return value.toString("base64url"); }
function randomToken(prefix: string): string { return `${prefix}_${b64url(randomBytes(32))}`; }
function asSeconds(date: Date): number { return Math.floor(date.getTime() / 1000); }

function safeJson(value: string): unknown {
  try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { return null; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function normalizeRedirectUri(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new OAuthRequestError("invalid_request", "redirect_uri must be an absolute URL"); }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new OAuthRequestError("invalid_request", "redirect_uri must use HTTPS or explicit loopback HTTP");
  }
  return url.toString();
}

function parseScope(value: string | undefined): string[] {
  const scopes = value?.trim() ? value.trim().split(/\s+/) : [TOOL_SCOPE];
  if (new Set(scopes).size !== scopes.length || !scopes.every(isScope) || !scopes.includes(TOOL_SCOPE)) {
    throw new OAuthRequestError("invalid_scope", "scope must include trust_layer:tools and only supported scopes");
  }
  return scopes;
}

function ensurePkce(challenge: string, method: string): void {
  if (method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
    throw new OAuthRequestError("invalid_request", "S256 PKCE code_challenge is required");
  }
}

function validVerifier(value: string): boolean { return /^[A-Za-z0-9._~-]{43,128}$/.test(value); }

/**
 * Minimal self-hosted OAuth 2.1 authorization server. It is intentionally
 * single-operator: the configured operator authenticates in the authorize
 * form, while DCR creates public clients for MCP connector interoperability.
 */
export class OAuthService {
  private readonly settings: Required<OAuthSettings>;
  private state: OAuthState = emptyOAuthState();
  private initialized = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly database: TrustLayerDatabase, settings: OAuthSettings) {
    const publicUrl = requireAbsoluteUrl("TRUST_LAYER_PUBLIC_BASE_URL", settings.publicBaseUrl, true);
    const issuer = requireAbsoluteUrl("TRUST_LAYER_OAUTH_ISSUER", settings.issuer, true);
    if (publicUrl.pathname !== "/" || issuer.pathname !== "/" || publicUrl.origin !== issuer.origin) {
      throw new Error("TRUST_LAYER_PUBLIC_BASE_URL and TRUST_LAYER_OAUTH_ISSUER must be the same origin without a path");
    }
    if (!settings.operatorUsername.trim() || settings.operatorUsername.length > 160) throw new Error("TRUST_LAYER_OAUTH_OPERATOR_USERNAME must be set");
    if (!settings.operatorPassword || settings.operatorPassword.length < 12) throw new Error("TRUST_LAYER_OAUTH_OPERATOR_PASSWORD must be at least 12 characters");
    const signingSecret = requireSecret("TRUST_LAYER_OAUTH_SIGNING_SECRET", settings.signingSecret);
    if (signingSecret.length < 32) throw new Error("TRUST_LAYER_OAUTH_SIGNING_SECRET must be at least 32 characters");
    this.settings = {
      issuer: issuer.origin,
      publicBaseUrl: publicUrl.origin,
      signingSecret,
      operatorUsername: settings.operatorUsername,
      operatorPassword: settings.operatorPassword,
      now: settings.now ?? (() => new Date()),
    };
  }

  get resourceUrl(): string { return new URL("/mcp", this.settings.publicBaseUrl).toString(); }
  get authorizationEndpoint(): string { return new URL("/oauth/authorize", this.settings.issuer).toString(); }
  get tokenEndpoint(): string { return new URL("/oauth/token", this.settings.issuer).toString(); }
  get registrationEndpoint(): string { return new URL("/oauth/register", this.settings.issuer).toString(); }
  get metadataEndpoint(): string { return new URL("/.well-known/oauth-authorization-server", this.settings.issuer).toString(); }

  async initialize(): Promise<void> { await this.exclusive(async () => undefined); }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.resourceUrl,
      authorization_servers: [this.settings.issuer],
      scopes_supported: [TOOL_SCOPE, OFFLINE_SCOPE],
      bearer_methods_supported: ["header"],
    };
  }

  authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.settings.issuer,
      authorization_endpoint: this.authorizationEndpoint,
      token_endpoint: this.tokenEndpoint,
      registration_endpoint: this.registrationEndpoint,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [TOOL_SCOPE, OFFLINE_SCOPE],
    };
  }

  async registerClient(input: unknown): Promise<OAuthClient> {
    if (!isRecord(input) || !Array.isArray(input.redirect_uris)) {
      throw new OAuthRequestError("invalid_client_metadata", "redirect_uris must be a non-empty string array");
    }
    const redirectCandidates = input.redirect_uris;
    if (redirectCandidates.length === 0 || redirectCandidates.length > 10 || !redirectCandidates.every((uri): uri is string => typeof uri === "string")) throw new OAuthRequestError("invalid_client_metadata", "redirect_uris must be a non-empty string array");
    if (input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== "none") {
      throw new OAuthRequestError("invalid_client_metadata", "only public clients without token endpoint authentication are supported");
    }
    const redirectUris = redirectCandidates.map(normalizeRedirectUri);
    if (new Set(redirectUris).size !== redirectUris.length) throw new OAuthRequestError("invalid_client_metadata", "redirect_uris must not contain duplicates");
    return this.exclusive(async () => {
      const client: OAuthClient = { clientId: randomToken("tlc"), redirectUris, createdAt: this.settings.now().toISOString() };
      this.state.clients[client.clientId] = client;
      await this.database.saveOAuthState(this.state);
      return client;
    });
  }

  async authorize(request: AuthorizationRequest, credentials: { username: string; password: string }): Promise<{ redirectUri: string; code: string; state?: string }> {
    this.validateAuthorizationRequest(request);
    const redirectUri = normalizeRedirectUri(request.redirectUri);
    if (!constantTimeEquals(credentials.username, this.settings.operatorUsername) || !constantTimeEquals(credentials.password, this.settings.operatorPassword)) {
      throw new OAuthRequestError("access_denied", "operator credentials were rejected", 401);
    }
    return this.exclusive(async () => {
      const client = this.state.clients[request.clientId];
      if (!client || !client.redirectUris.includes(redirectUri)) throw new OAuthRequestError("invalid_request", "redirect_uri is not registered for client_id");
      const rawCode = randomToken("tlac");
      const codeKey = this.hash("authorization-code", rawCode);
      this.state.authorizationCodes[codeKey] = {
        clientId: request.clientId,
        redirectUri,
        codeChallenge: request.codeChallenge,
        resource: request.resource,
        scope: parseScope(request.scope),
        subject: this.settings.operatorUsername,
        expiresAt: new Date(this.settings.now().getTime() + AUTHORIZATION_CODE_TTL_MS).toISOString(),
      };
      await this.database.saveOAuthState(this.state);
      return { redirectUri, code: rawCode, ...(request.state ? { state: request.state } : {}) };
    });
  }

  async exchangeAuthorizationCode(input: Record<string, string>): Promise<Record<string, unknown>> {
    if (input.grant_type !== "authorization_code") throw new OAuthRequestError("unsupported_grant_type", "grant_type must be authorization_code");
    if (!input.code || !input.client_id || !input.redirect_uri || !input.code_verifier || !input.resource) throw new OAuthRequestError("invalid_request", "code, client_id, redirect_uri, code_verifier, and resource are required");
    if (!validVerifier(input.code_verifier)) throw new OAuthRequestError("invalid_request", "code_verifier is invalid");
    return this.exclusive(async () => {
      const codeKey = this.hash("authorization-code", input.code);
      const code = this.state.authorizationCodes[codeKey];
      delete this.state.authorizationCodes[codeKey]; // One-time use even when validation fails.
      await this.database.saveOAuthState(this.state);
      if (!code || new Date(code.expiresAt).getTime() <= this.settings.now().getTime()) throw new OAuthRequestError("invalid_grant", "authorization code is invalid or expired");
      let redirectUri: string;
      try { redirectUri = normalizeRedirectUri(input.redirect_uri); } catch { throw new OAuthRequestError("invalid_grant", "authorization code binding did not match"); }
      if (code.clientId !== input.client_id || code.redirectUri !== redirectUri || code.resource !== input.resource) throw new OAuthRequestError("invalid_grant", "authorization code binding did not match");
      const challenge = b64url(createHash("sha256").update(input.code_verifier).digest());
      if (!constantTimeEquals(challenge, code.codeChallenge)) throw new OAuthRequestError("invalid_grant", "PKCE verification failed");
      return this.tokenResponse(code.clientId, code.subject, code.resource, code.scope);
    });
  }

  async exchangeRefreshToken(input: Record<string, string>): Promise<Record<string, unknown>> {
    if (input.grant_type !== "refresh_token") throw new OAuthRequestError("unsupported_grant_type", "grant_type must be refresh_token");
    if (!input.refresh_token || !input.client_id || !input.resource) throw new OAuthRequestError("invalid_request", "refresh_token, client_id, and resource are required");
    return this.exclusive(async () => {
      const key = this.hash("refresh-token", input.refresh_token);
      const refresh = this.state.refreshTokens[key];
      delete this.state.refreshTokens[key]; // Rotation: a token is never usable twice.
      await this.database.saveOAuthState(this.state);
      if (!refresh || new Date(refresh.expiresAt).getTime() <= this.settings.now().getTime()) throw new OAuthRequestError("invalid_grant", "refresh token is invalid or expired");
      if (refresh.clientId !== input.client_id || refresh.resource !== input.resource || !refresh.scope.includes(OFFLINE_SCOPE)) throw new OAuthRequestError("invalid_grant", "refresh token binding did not match");
      return this.tokenResponse(refresh.clientId, refresh.subject, refresh.resource, refresh.scope);
    });
  }

  validateAccessToken(token: string): OAuthAccessTokenClaims | null {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerPart, payloadPart, signaturePart] = parts;
    const header = safeJson(headerPart);
    const payload = safeJson(payloadPart);
    if (!isRecord(header) || header.alg !== "HS256" || header.typ !== "JWT" || !isRecord(payload)) return null;
    const expected = b64url(createHmac("sha256", this.settings.signingSecret).update(`${headerPart}.${payloadPart}`).digest());
    if (!constantTimeEquals(expected, signaturePart)) return null;
    const requiredStrings = ["iss", "aud", "sub", "scope", "client_id"];
    if (requiredStrings.some((key) => typeof payload[key] !== "string") || typeof payload.exp !== "number" || typeof payload.iat !== "number") return null;
    const iss = payload.iss as string;
    const aud = payload.aud as string;
    const sub = payload.sub as string;
    const scopeRaw = payload.scope as string;
    const clientId = payload.client_id as string;
    const exp = payload.exp;
    const iat = payload.iat;
    if (iss !== this.settings.issuer || aud !== this.resourceUrl || exp <= asSeconds(this.settings.now()) || iat > asSeconds(this.settings.now()) + 60) return null;
    const scope = scopeRaw.split(" ").filter(Boolean);
    if (!scope.includes(TOOL_SCOPE) || !scope.every(isScope)) return null;
    return { issuer: iss, audience: aud, subject: sub, scope, clientId, expiresAt: exp, issuedAt: iat };
  }

  /** Test-only helper; no HTTP route exposes token issuance outside OAuth grants. */
  issueTestAccessToken(subject: string, scope: string[] = [TOOL_SCOPE]): string {
    if (!subject || !scope.includes(TOOL_SCOPE) || !scope.every(isScope)) throw new Error("invalid test token claims");
    return this.signAccessToken("test-client", subject, this.resourceUrl, scope);
  }

  private validateAuthorizationRequest(request: AuthorizationRequest): void {
    if (!request.clientId || !request.resource || request.resource !== this.resourceUrl) throw new OAuthRequestError("invalid_target", "resource must exactly identify this MCP server");
    normalizeRedirectUri(request.redirectUri);
    ensurePkce(request.codeChallenge, request.codeChallengeMethod);
    parseScope(request.scope);
  }

  private async tokenResponse(clientId: string, subject: string, resource: string, scope: string[]): Promise<Record<string, unknown>> {
    const accessToken = this.signAccessToken(clientId, subject, resource, scope);
    const result: Record<string, unknown> = { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SECONDS, scope: scope.join(" ") };
    if (scope.includes(OFFLINE_SCOPE)) {
      const refreshToken = randomToken("tlrt");
      this.state.refreshTokens[this.hash("refresh-token", refreshToken)] = {
        clientId, resource, scope: [...scope], subject,
        expiresAt: new Date(this.settings.now().getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
      };
      await this.database.saveOAuthState(this.state);
      result.refresh_token = refreshToken;
    }
    return result;
  }

  private signAccessToken(clientId: string, subject: string, resource: string, scope: string[]): string {
    const now = asSeconds(this.settings.now());
    const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
    const payload = b64url(Buffer.from(JSON.stringify({ iss: this.settings.issuer, aud: resource, sub: subject, scope: scope.join(" "), client_id: clientId, iat: now, exp: now + ACCESS_TOKEN_TTL_SECONDS, jti: randomToken("jti") })));
    const signature = b64url(createHmac("sha256", this.settings.signingSecret).update(`${header}.${payload}`).digest());
    return `${header}.${payload}.${signature}`;
  }

  private hash(purpose: string, token: string): string { return createHmac("sha256", this.settings.signingSecret).update(`${purpose}:${token}`).digest("hex"); }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: (() => void) | undefined;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (!this.initialized) {
        this.state = await this.database.loadOAuthState() ?? emptyOAuthState();
        this.initialized = true;
      }
      return await operation();
    } finally {
      release?.();
    }
  }
}

export function createOAuthServiceFromEnvironment(database: TrustLayerDatabase, environment: NodeJS.ProcessEnv = process.env): OAuthService {
  const signingSecret = requireSecret("TRUST_LAYER_OAUTH_SIGNING_SECRET", environment.TRUST_LAYER_OAUTH_SIGNING_SECRET);
  const trustLayerSecret = requireSecret("TRUST_LAYER_SECRET", environment.TRUST_LAYER_SECRET);
  if (constantTimeEquals(signingSecret, trustLayerSecret)) throw new Error("TRUST_LAYER_OAUTH_SIGNING_SECRET must be independent from TRUST_LAYER_SECRET");
  const allowLoopbackHttp = environment.NODE_ENV !== "production";
  const publicBaseUrl = requireAbsoluteUrl("TRUST_LAYER_PUBLIC_BASE_URL", environment.TRUST_LAYER_PUBLIC_BASE_URL, allowLoopbackHttp).origin;
  const issuer = requireAbsoluteUrl("TRUST_LAYER_OAUTH_ISSUER", environment.TRUST_LAYER_OAUTH_ISSUER, allowLoopbackHttp).origin;
  return new OAuthService(database, {
    publicBaseUrl,
    issuer,
    signingSecret,
    operatorUsername: environment.TRUST_LAYER_OAUTH_OPERATOR_USERNAME ?? "",
    operatorPassword: environment.TRUST_LAYER_OAUTH_OPERATOR_PASSWORD ?? "",
  });
}
