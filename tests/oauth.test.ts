import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { request, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { parseAllowedOrigins, requireSecret } from "../src/config.js";
import { PostgresCompatDatabase, PostgresDatabase, type PostgresClient, type PostgresPool, type PostgresQueryResult } from "../src/db.js";
import { OAuthService } from "../src/oauth.js";
import { createHttpServer } from "../src/server.js";
import { TrustLayerService } from "../src/service.js";

function oauth(now?: () => Date): OAuthService {
  return new OAuthService(new PostgresCompatDatabase(), { publicBaseUrl: "http://localhost", issuer: "http://localhost", signingSecret: "oauth-test-signing-secret-32-chars!", operatorUsername: "operator", operatorPassword: "operator-password", ...(now ? { now } : {}) });
}

function stringField(value: Record<string, unknown>, name: string): string {
  if (typeof value[name] !== "string") throw new Error(`missing ${name}`);
  return value[name];
}

function post(port: number, path: string, body: unknown): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request({ hostname: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text ? JSON.parse(text) : null });
      });
    });
    req.on("error", reject); req.end(payload);
  });
}

class InProcessResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  readonly headers: Record<string, string | string[] | undefined> = {};
  private readonly chunks: Buffer[] = [];

  setHeader(name: string, value: number | string | readonly string[]): void {
    if (typeof value === "number") this.headers[name.toLowerCase()] = String(value);
    else if (Array.isArray(value)) this.headers[name.toLowerCase()] = [...value] as string[];
    else this.headers[name.toLowerCase()] = value as string;
  }

  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    this.headersSent = true;
    this.emit("finish");
    return this;
  }

  body(): unknown {
    const text = Buffer.concat(this.chunks).toString("utf8");
    return text ? JSON.parse(text) : null;
  }
}

async function postInProcess(server: ReturnType<typeof createHttpServer>, path: string, body: unknown): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: unknown }> {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(req, { method: "POST", url: path, headers: { "content-type": "application/json" } });
  const response = new InProcessResponse();
  await (server.listeners("request")[0] as RequestListener)(req, response as unknown as ServerResponse);
  return { status: response.statusCode, headers: response.headers, body: response.body() };
}

class RecordingClient implements PostgresClient {
  readonly queries: string[] = [];
  failRuntimeWrite = false;
  async query(statement: string, _values?: readonly unknown[]): Promise<PostgresQueryResult> {
    this.queries.push(statement);
    if (this.failRuntimeWrite && statement.startsWith("INSERT INTO trust_layer_runtime_state")) throw new Error("simulated database error");
    return { rows: [] };
  }
  release(): void { /* test double */ }
}

class RecordingPool implements PostgresPool {
  readonly client = new RecordingClient();
  async connect(): Promise<PostgresClient> { return this.client; }
  async end(): Promise<void> { /* test double */ }
}

describe("OAuth 2.1 and production PostgreSQL contracts", () => {
  let httpServer: ReturnType<typeof createHttpServer> | undefined;
  afterEach(async () => { if (httpServer?.listening) await new Promise<void>((resolve) => httpServer!.close(() => resolve())); httpServer = undefined; });

  it("implements DCR, authorization-code S256 PKCE, and rotating refresh tokens", async () => {
    const service = oauth();
    const client = await service.registerClient({ redirect_uris: ["http://localhost:3000/callback"], token_endpoint_auth_method: "none" });
    const verifier = "a".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorization = await service.authorize({ clientId: client.clientId, redirectUri: client.redirectUris[0], codeChallenge: challenge, codeChallengeMethod: "S256", resource: service.resourceUrl, scope: "trust_layer:tools offline_access", state: "state-1" }, { username: "operator", password: "operator-password" });
    const tokens = await service.exchangeAuthorizationCode({ grant_type: "authorization_code", code: authorization.code, client_id: client.clientId, redirect_uri: client.redirectUris[0], code_verifier: verifier, resource: service.resourceUrl });
    const accessToken = stringField(tokens, "access_token");
    const refreshToken = stringField(tokens, "refresh_token");
    expect(service.validateAccessToken(accessToken)).toMatchObject({ issuer: "http://localhost", audience: service.resourceUrl, subject: "operator" });
    const refreshed = await service.exchangeRefreshToken({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.clientId, resource: service.resourceUrl });
    expect(stringField(refreshed, "refresh_token")).not.toBe(refreshToken);
    await expect(service.exchangeRefreshToken({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.clientId, resource: service.resourceUrl })).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("rejects expired access tokens and publishes required metadata", () => {
    let now = new Date("2026-08-24T00:00:00Z");
    const service = oauth(() => now);
    const token = service.issueTestAccessToken("operator");
    expect(service.validateAccessToken(token)).not.toBeNull();
    now = new Date("2026-08-24T00:16:00Z");
    expect(service.validateAccessToken(token)).toBeNull();
    expect(service.protectedResourceMetadata()).toMatchObject({ resource: service.resourceUrl, authorization_servers: ["http://localhost"] });
    expect(service.authorizationServerMetadata()).toMatchObject({ issuer: "http://localhost", code_challenge_methods_supported: ["S256"] });
  });

  it("returns a 401 Bearer challenge with protected-resource metadata for unauthenticated MCP", async () => {
    const trustService = new TrustLayerService({ dbFile: null, secret: "server-secret" });
    const oauthService = oauth();
    httpServer = createHttpServer(trustService, oauthService);
    const response = await postInProcess(httpServer, "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("resource_metadata=");
  });

  it("fails closed for missing/default application secret and malformed origin configuration", () => {
    expect(() => requireSecret("TRUST_LAYER_SECRET", undefined)).toThrow("must be set");
    expect(() => requireSecret("TRUST_LAYER_SECRET", "trust-layer-local-mvp-secret-change-me")).toThrow("retired development default");
    expect(() => new TrustLayerService({ secret: "" })).toThrow("TRUST_LAYER_SECRET must be set");
    expect(parseAllowedOrigins('["https://claude.ai","http://localhost"]')).toEqual(["https://claude.ai", "http://localhost"]);
    expect(() => parseAllowedOrigins("*")).toThrow("wildcard");
    expect(() => parseAllowedOrigins("[]")).toThrow("non-empty");
  });

  it("uses BEGIN/COMMIT and rolls back the real adapter contract on persistence failure", async () => {
    const successPool = new RecordingPool();
    const successDatabase = new PostgresDatabase({ connectionString: "postgres://example.invalid/trust", pool: successPool });
    const successService = new TrustLayerService({ database: successDatabase, secret: "postgres-contract-secret" });
    await successService.issueSyntheticToken("postgres-test");
    expect(successPool.client.queries.some((statement) => statement.startsWith("CREATE TABLE IF NOT EXISTS participants"))).toBe(true);
    expect(successPool.client.queries).toContain("BEGIN");
    expect(successPool.client.queries).toContain("COMMIT");

    const failurePool = new RecordingPool();
    failurePool.client.failRuntimeWrite = true;
    const failureDatabase = new PostgresDatabase({ connectionString: "postgres://example.invalid/trust", pool: failurePool });
    const failureService = new TrustLayerService({ database: failureDatabase, secret: "postgres-contract-secret" });
    await expect(failureService.issueSyntheticToken("postgres-test")).rejects.toThrow("simulated database error");
    expect(failurePool.client.queries).toContain("ROLLBACK");
  });
});
