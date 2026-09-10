import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createDatabaseFromEnvironment } from "./db.js";
import { createOAuthServiceFromEnvironment, OAuthRequestError, OAuthService } from "./oauth.js";
import { TrustLayerService } from "./service.js";
import type { ToolContext } from "./types.js";
import { AbuseControls, AbuseLimitError } from "./abuseControls.js";
import { FeedbackValidationError, parsePublicFeedback } from "./feedback.js";
import {
  normalizePublicDomain,
  PublicDomainValidationError,
  PublicLookup,
  PublicLookupUnavailableError,
  validateSourceRoutes,
} from "./publicLookup.js";

const domain = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/).max(253);
const researchId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const modelName = z.enum(["openai_gpt5", "anthropic_claude4", "google_gemini3", "local_fixed", "other_fixed", "unknown"]);
const outcome = z.enum(["used_as_support", "rejected_or_conflicted", "insufficient_evidence"]);
const reasonCode = z.enum(["direct_evidence", "primary_source_conflict", "stale_or_changed", "citation_missing", "unclear"]);
const guidanceVersion = z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/);
const sourceRef = z.string().regex(/^s[1-9][0-9]{0,3}$/);
const sourceCommon = {
  source_ref: sourceRef, domain, source_disposition: z.enum(["used_as_support", "rejected_or_conflicted", "considered_not_relied", "unreadable"]),
  reason_codes: z.array(z.enum(["primary_source", "directly_addresses_scope", "cross_verified", "contradicted_by_primary", "stale_or_changed", "citation_missing", "unreadable_or_paywalled", "irrelevant_to_scope", "unclear"])).min(1).max(3).refine((items: string[]) => new Set(items).size === items.length),
  related_source_refs: z.array(sourceRef).max(3).refine((items: string[]) => new Set(items).size === items.length), source_type: z.enum(["primary", "regulator", "publisher", "community", "unknown"]),
  published_date_precision: z.enum(["day", "month", "year", "unknown"]),
};
const source = z.union([
  z.object({ ...sourceCommon, url_scope: z.literal("canonical_url"), canonical_url: z.string().url().regex(/^https:\/\//).max(2048) }).strict(),
  z.object({ ...sourceCommon, url_scope: z.literal("domain_only") }).strict(),
]);
const questionContext = z.object({
  intent_category: z.enum(["factual_lookup", "comparison", "how_to", "current_event", "recommendation", "high_stakes"]),
  claim_scope_tags: z.array(z.enum(["company_policy", "product_spec", "price", "availability", "safety", "other_fixed"])).max(3).refine((items: string[]) => new Set(items).size === items.length),
  sensitivity: z.enum(["standard", "sensitive"]),
}).strict();
const finalAssessment = z.object({ domain, outcome, reason_code: reasonCode }).strict();
const manifest = z.object({
  source_count_total: z.number().int().min(1).max(120), batch_index: z.number().int().min(1).max(10), batch_count: z.number().int().min(1).max(10), complete: z.boolean(),
  sources: z.array(source).min(1).max(12).refine((items: unknown[]) => new Set(items.map((item) => JSON.stringify(item))).size === items.length), final_assessment: finalAssessment.optional(),
}).strict();
// The batch schema is deliberately transport-only. The MCP SDK validates this
// Zod schema before invoking the handler, so the closed outer JSON Schema and
// per-item assessment validation stay in TrustLayerService.
const batchTransportInput = z.object({ assessments: z.unknown().optional() }).passthrough();

export const mcpInputSchemas = {
  report_domain_assessment: z.object({ research_id: researchId, collection_mode: z.literal("minimal_observation"), rubric_version: z.literal("0.3"), guidance_version: guidanceVersion.optional(), domain, outcome, reason_code: reasonCode, agent_model_name: modelName }).strict(),
  report_domain_assessments_batch: batchTransportInput,
  report_research_manifest: z.object({ research_id: researchId, collection_mode: z.literal("evidence_manifest"), rubric_version: z.literal("0.3"), guidance_version: guidanceVersion.optional(), agent_model_name: modelName, question_context: questionContext, manifest }).strict(),
  submit_local_verification: z.object({
    attestation_schema_version: z.literal("0.1"), research_id: researchId, verification_mode: z.literal("local_byo_api"), rubric_version: z.literal("0.3"),
    checked_source_refs: z.array(sourceRef).min(1).max(12).refine((items: string[]) => new Set(items).size === items.length), result: z.enum(["consistent", "inconsistent", "inconclusive"]),
    result_codes: z.array(z.enum(["primary_source_found", "primary_source_missing", "source_unavailable", "conflict_detected", "no_material_conflict", "scope_indeterminate"])).min(1).max(3).refine((items: string[]) => new Set(items).size === items.length),
    alternative_source_refs: z.array(sourceRef).max(3).refine((items: string[]) => new Set(items).size === items.length), client_verifier_version: z.literal("0.1"),
  }).strict(),
  lookup_domain_signal: z.object({ domain }).strict(),
} as const;

export function mcpInputAccepts(tool: keyof typeof mcpInputSchemas, value: unknown): boolean {
  return mcpInputSchemas[tool].safeParse(value).success;
}

class BodyLimitError extends Error {}

function readRawBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const fail = (error: Error) => { cleanup(); req.pause(); reject(error); };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { fail(new BodyLimitError("body too large")); return; }
      chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks).toString("utf8")); };
    const onError = (error: Error) => fail(error);
    const onAborted = () => fail(new Error("request aborted"));
    const timer = setTimeout(() => fail(new BodyLimitError("body timeout")), 5_000);
    timer.unref();
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}

async function readJsonBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  return JSON.parse(await readRawBody(req, maxBytes));
}

async function readFormBody(req: IncomingMessage): Promise<Record<string, string>> {
  const params = new URLSearchParams(await readRawBody(req, 16 * 1024));
  const result: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(result, key)) throw new OAuthRequestError("invalid_request", "duplicate form parameters are not allowed");
    result[key] = value;
  }
  return result;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function setPublicCors(res: ServerResponse, methods = "GET, OPTIONS"): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", methods);
  res.setHeader("access-control-allow-headers", "content-type");
}

function requestSourceKey(req: IncomingMessage): string {
  // Do not trust client-controlled X-Forwarded-For. Render's direct socket
  // peer is the only source used by this process-local limiter.
  return req.socket?.remoteAddress || "unknown";
}

function projectRootCandidates(moduleDir: string, relativePath: string): string[] {
  return [
    resolve(moduleDir, "..", relativePath),
    resolve(moduleDir, "..", "..", relativePath),
    resolve(process.cwd(), relativePath),
  ];
}

function loadPublicHtml(moduleDir: string): string | null {
  const path = projectRootCandidates(moduleDir, join("public", "index.html")).find((candidate) => existsSync(candidate));
  return path ? readFileSync(path, "utf8") : null;
}

function loadSourceRoutes(moduleDir: string): ReturnType<typeof validateSourceRoutes> {
  const path = projectRootCandidates(moduleDir, join("data", "source-routes.json")).find((candidate) => existsSync(candidate));
  if (!path) throw new PublicLookupUnavailableError();
  return validateSourceRoutes(JSON.parse(readFileSync(path, "utf8")));
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function asString(value: string | string[] | undefined): string | undefined { return typeof value === "string" ? value : undefined; }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * CallToolRequestSchema is parsed by the SDK before McpServer's tool handler
 * runs. Keep malformed arguments out of that parser so its raw Zod error
 * cannot become a JSON-RPC Internal error response.
 */
function invalidToolCallArguments(value: unknown): { id: unknown } | undefined {
  if (!isRecord(value) || value.method !== "tools/call" || !Object.hasOwn(value, "id")) return undefined;
  const params = value.params;
  if (!isRecord(params)) return undefined;
  // The batch tool deliberately accepts an optional transport envelope so an
  // omitted arguments object can reach TrustLayerService and become its
  // structured invalid_schema response. The other tools use strict schemas;
  // an omitted arguments object would otherwise be replaced with undefined by
  // the SDK and expose its raw Zod validation details.
  if (!Object.hasOwn(params, "arguments")) {
    return params.name === "report_domain_assessments_batch" ? undefined : { id: value.id };
  }
  return isRecord(params.arguments) ? undefined : { id: value.id };
}

function normalizeOmittedBatchArguments(value: unknown): unknown {
  if (!isRecord(value) || value.method !== "tools/call" || !isRecord(value.params)) return value;
  if (value.params.name !== "report_domain_assessments_batch" || Object.hasOwn(value.params, "arguments")) return value;
  return { ...value, params: { ...value.params, arguments: {} } };
}

function authorizationRequestFrom(url: URL): { clientId: string; redirectUri: string; codeChallenge: string; codeChallengeMethod: string; resource: string; scope?: string; state?: string } {
  const required = (name: string): string => {
    const value = url.searchParams.get(name);
    if (!value) throw new OAuthRequestError("invalid_request", `${name} is required`);
    return value;
  };
  if (url.searchParams.get("response_type") !== "code") throw new OAuthRequestError("unsupported_response_type", "response_type must be code");
  return {
    clientId: required("client_id"), redirectUri: required("redirect_uri"), codeChallenge: required("code_challenge"),
    codeChallengeMethod: required("code_challenge_method"), resource: required("resource"),
    ...(url.searchParams.get("scope") ? { scope: url.searchParams.get("scope") ?? undefined } : {}),
    ...(url.searchParams.get("state") ? { state: url.searchParams.get("state") ?? undefined } : {}),
  };
}

function authorizationForm(action: string, url: URL): string {
  const fields = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "resource", "scope", "state"]
    .flatMap((name) => {
      const value = url.searchParams.get(name);
      return value === null ? [] : [`<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`];
    }).join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Trust Layer authorization</title><body><main><h1>Authorize Trust Layer</h1><p>Sign in as the configured operator to allow this connector to access Trust Layer.</p><form method="post" action="${escapeHtml(action)}">${fields}<label>Username <input name="username" autocomplete="username" required></label><label>Password <input type="password" name="password" autocomplete="current-password" required></label><button type="submit">Authorize</button></form></main></body></html>`;
}

function unauthorized(res: ServerResponse, oauth: OAuthService, error?: string): void {
  const metadata = new URL("/.well-known/oauth-protected-resource", oauth.resourceUrl).toString();
  const parameters = [`resource_metadata="${metadata}"`];
  if (error) parameters.push(`error="${error}"`);
  res.setHeader("www-authenticate", `Bearer ${parameters.join(", ")}`);
  sendJson(res, 401, { error: error ?? "invalid_token" });
}

export function createMcpServer(service: TrustLayerService, context: ToolContext = {}): McpServer {
  const server = new McpServer({ name: "trust-layer", version: "0.3.0" });
  const run = async (tool: Parameters<TrustLayerService["executeTool"]>[0], input: unknown) => {
    const result = await service.executeTool(tool, input, context);
    return { isError: !result.ok, content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
  };
  server.registerTool("report_domain_assessment", { title: "Report domain assessment", description: "Submit exactly one minimal synthetic observation for one domain. For several independently assessed domains, use report_domain_assessments_batch; for multiple sources supporting one domain, use report_research_manifest.", inputSchema: mcpInputSchemas.report_domain_assessment }, async (input) => run("report_domain_assessment", input));
  server.registerTool("report_domain_assessments_batch", {
    title: "Report domain assessments in batch",
    description: [
      "Submit 1 to 5 independent minimal domain assessments in one request.",
      "Every item must have a distinct research_id. This batches transport only;",
      "it stores no URLs, query text, or page content and does not change aggregation.",
      "Use report_research_manifest, not this tool, when multiple sources support one domain.",
      "Read each ordered result and retry only items whose retry_directive permits it.",
    ].join(" "),
    inputSchema: mcpInputSchemas.report_domain_assessments_batch,
  }, async (input) => run("report_domain_assessments_batch", input));
  server.registerTool("report_research_manifest", { title: "Report research manifest", description: "Submit a complete or batched evidence manifest.", inputSchema: mcpInputSchemas.report_research_manifest }, async (input) => run("report_research_manifest", input));
  server.registerTool("submit_local_verification", { title: "Submit local verification", description: "Submit a fixed-shape BYO verification attestation.", inputSchema: mcpInputSchemas.submit_local_verification }, async (input) => run("submit_local_verification", input));
  server.registerTool("lookup_domain_signal", { title: "Lookup domain signal", description: "Read the conservative rolling domain signal.", inputSchema: mcpInputSchemas.lookup_domain_signal }, async (input) => run("lookup_domain_signal", input));
  return server;
}

export function createHttpServer(service: TrustLayerService, oauth: OAuthService): ReturnType<typeof createServer> {
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport; authorization: string }>();
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const publicHtml = loadPublicHtml(moduleDir);
  const scriptPath = projectRootCandidates(moduleDir, join("public", "app.js")).find((candidate) => existsSync(candidate));
  const publicScript = scriptPath ? readFileSync(scriptPath, "utf8") : null;
  let publicLookup: PublicLookup | undefined;
  try {
    const lookup = new PublicLookup(loadSourceRoutes(moduleDir), new Map(), 60_000, 60_000, () => service.clock.now().getTime());
    publicLookup = lookup;
    service.attachPublicProjectionPublisher((publication) => lookup.applyProjectionPublication(publication));
  } catch { publicLookup = undefined; }
  const abuseControls = new AbuseControls();
  const sweepTimer = setInterval(() => { abuseControls.sweep(); publicLookup?.sweep(); }, 20_000);
  sweepTimer.unref();
  const server = createServer({ maxHeaderSize: 16 * 1024 }, async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    // Set before parsing/admission so dynamic failures cannot be cached.
    res.setHeader("cache-control", "no-store");
    try {
      const release = abuseControls.admit(requestSourceKey(req));
      res.once("finish", release);
      res.once("close", release);
      req.once("aborted", release);
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      const path = requestUrl.pathname;
      if (path.startsWith("/api/public/")) {
        // Do not keep sockets carrying unread/rejected bodies alive.
        res.shouldKeepAlive = false;
        res.once("finish", () => { if (req.complete === false) req.destroy(); });
        const length = Number(req.headers["content-length"] ?? 0);
        if (!Number.isSafeInteger(length) || length < 0 || length > 8 * 1024) throw new BodyLimitError("body too large");
        if (req.method !== "POST" && (length > 0 || req.headers["transfer-encoding"])) throw new BodyLimitError("unexpected body");
      }
      if (path === "/public/app.js" && req.method === "GET") {
        if (publicScript === null) { sendJson(res, 503, { error: "service_unavailable" }); return; }
        res.setHeader("content-type", "text/javascript; charset=utf-8");
        res.end(publicScript);
        return;
      }
      if (path === "/healthz" && req.method === "GET") { sendJson(res, 200, { status: "ok" }); return; }
      if ((path === "/" || path === "/index.html" || path === "/public/index.html") && req.method === "GET") {
        if (publicHtml === null) { sendJson(res, 503, { error: "service_unavailable" }); return; }
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.setHeader("content-security-policy", "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'unsafe-inline'");
        res.end(publicHtml);
        return;
      }
      if (path === "/api/public/domain-signal") {
        setPublicCors(res);
        if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
        if (req.method !== "GET") { res.statusCode = 405; res.setHeader("allow", "GET, OPTIONS"); res.end(); return; }
        if (!publicLookup) throw new PublicLookupUnavailableError();
        await service.initialize();
        const rawDomain = requestUrl.searchParams.get("domain");
        if (rawDomain === null) throw new PublicDomainValidationError();
        const domain = normalizePublicDomain(rawDomain);
        const cacheHit = publicLookup.isCached(domain);
        abuseControls.reservePublicLookup(requestSourceKey(req), cacheHit);
        sendJson(res, 200, publicLookup.lookup(domain));
        return;
      }
      if (path === "/api/public/feedback") {
        setPublicCors(res, "POST, OPTIONS");
        if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
        if (req.method !== "POST") { res.statusCode = 405; res.setHeader("allow", "POST, OPTIONS"); res.end(); return; }
        abuseControls.reserveFeedback(requestSourceKey(req));
        const feedback = parsePublicFeedback(await readJsonBody(req, 8 * 1024));
        // The MVP intentionally acknowledges only. No vote, domain state, or
        // free-form text is persisted by this endpoint.
        void feedback;
        sendJson(res, 202, { accepted: true });
        return;
      }
      if (path === "/.well-known/oauth-protected-resource" && req.method === "GET") { sendJson(res, 200, oauth.protectedResourceMetadata()); return; }
      if (path === "/.well-known/oauth-authorization-server" && req.method === "GET") { sendJson(res, 200, oauth.authorizationServerMetadata()); return; }
      if (path === "/oauth/register" && req.method === "POST") {
        const client = await oauth.registerClient(await readJsonBody(req));
        sendJson(res, 201, { client_id: client.clientId, redirect_uris: client.redirectUris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
        return;
      }
      if (path === "/oauth/authorize" && req.method === "GET") {
        authorizationRequestFrom(requestUrl);
        res.statusCode = 200; res.setHeader("content-type", "text/html; charset=utf-8"); res.setHeader("cache-control", "no-store"); res.end(authorizationForm(path, requestUrl));
        return;
      }
      if (path === "/oauth/authorize" && req.method === "POST") {
        const form = await readFormBody(req);
        const source = new URLSearchParams(form);
        const authorizationUrl = new URL("/oauth/authorize", "http://localhost");
        for (const [key, value] of source) if (key !== "username" && key !== "password") authorizationUrl.searchParams.set(key, value);
        const authorization = await oauth.authorize(authorizationRequestFrom(authorizationUrl), { username: form.username ?? "", password: form.password ?? "" });
        const redirect = new URL(authorization.redirectUri);
        redirect.searchParams.set("code", authorization.code);
        if (authorization.state) redirect.searchParams.set("state", authorization.state);
        res.statusCode = 302; res.setHeader("location", redirect.toString()); res.setHeader("cache-control", "no-store"); res.end();
        return;
      }
      if (path === "/oauth/token" && req.method === "POST") {
        const form = await readFormBody(req);
        const token = form.grant_type === "authorization_code" ? await oauth.exchangeAuthorizationCode(form) : await oauth.exchangeRefreshToken(form);
        res.setHeader("cache-control", "no-store"); res.setHeader("pragma", "no-cache"); sendJson(res, 200, token);
        return;
      }
      if (path !== "/mcp") { sendJson(res, 404, { error: "not_found" }); return; }
      if (req.method !== "POST" && req.method !== "DELETE") { res.statusCode = 405; res.setHeader("allow", "POST, DELETE"); res.end(); return; }
      if (Number(req.headers["content-length"] ?? 0) > 64 * 1024) { sendJson(res, 413, { error: "request_too_large" }); return; }
      const authorization = asString(req.headers.authorization);
      if (!authorization) { unauthorized(res, oauth); return; }
      const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
      const claims = bearer ? oauth.validateAccessToken(bearer) : null;
      if (!claims) { unauthorized(res, oauth, "invalid_token"); return; }
      if (!claims.scope.includes("trust_layer:tools")) { res.setHeader("www-authenticate", 'Bearer error="insufficient_scope", scope="trust_layer:tools"'); sendJson(res, 403, { error: "insufficient_scope" }); return; }
      const origin = asString(req.headers.origin);
      if (origin !== undefined && !service.allowedOrigins.has(origin)) { sendJson(res, 403, { error: "origin_not_allowed" }); return; }
      const body = await readJsonBody(req, 64 * 1024);
      const requestMethod = typeof body === "object" && body !== null && "method" in body ? (body as { method?: unknown }).method : undefined;
      const sessionHeader = asString(req.headers["mcp-session-id"]);
      let session = sessionHeader ? sessions.get(sessionHeader) : undefined;
      if (!session && requestMethod !== "initialize") { sendJson(res, 400, { error: "session_required" }); return; }
      if (session && session.authorization !== authorization) { unauthorized(res, oauth, "invalid_token"); return; }
      const invalidArguments = invalidToolCallArguments(body);
      if (invalidArguments) {
        sendJson(res, 200, {
          jsonrpc: "2.0",
          id: invalidArguments.id,
          error: { code: -32602, message: "Invalid tool arguments" },
        });
        return;
      }
      const normalizedBody = normalizeOmittedBatchArguments(body);
      if (!session) {
        const sessionId = randomUUID();
        const server = createMcpServer(service, { origin, oauthSubject: claims.subject, oauthScopes: claims.scope });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId, enableJsonResponse: true });
        session = { server, transport, authorization };
        sessions.set(sessionId, session);
        transport.onclose = () => { sessions.delete(sessionId); };
        await server.connect(transport);
      }
      await session.transport.handleRequest(req, res, normalizedBody as never);
    } catch (error) {
      if (error instanceof OAuthRequestError) {
        const status = error.status;
        if (status === 401) res.setHeader("www-authenticate", 'Basic realm="Trust Layer operator"');
        sendJson(res, status, { error: error.code, error_description: error.description });
      } else if (error instanceof AbuseLimitError) {
        res.shouldKeepAlive = false;
        res.once("finish", () => { if (req.complete === false) req.destroy(); });
        res.setHeader("retry-after", String(error.retryAfterSeconds));
        sendJson(res, 429, { error: "rate_limited", retry_after_seconds: error.retryAfterSeconds });
      } else if (error instanceof BodyLimitError) {
        res.shouldKeepAlive = false;
        res.once("finish", () => { if (req.complete === false) req.destroy(); });
        sendJson(res, 413, { error: "invalid_request" });
      } else if (error instanceof PublicDomainValidationError || error instanceof FeedbackValidationError) {
        sendJson(res, 400, { error: error instanceof FeedbackValidationError ? "invalid_feedback" : "invalid_domain" });
      } else if (error instanceof PublicLookupUnavailableError) {
        sendJson(res, 503, { error: "service_unavailable" });
      } else if (!res.headersSent) {
        sendJson(res, 400, { error: "invalid_request" });
      } else res.end();
    }
  });
  server.on("close", () => { clearInterval(sweepTimer); service.stopMaintenance(); });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}

async function startFromEnvironment(): Promise<void> {
  const database = createDatabaseFromEnvironment();
  const service = new TrustLayerService({ database, secret: process.env.TRUST_LAYER_SECRET, stage: 1 });
  const oauth = createOAuthServiceFromEnvironment(database);
  await Promise.all([service.initialize(), oauth.initialize()]);
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "0.0.0.0";
  const server = createHttpServer(service, oauth);
  server.listen(port, host, () => { process.stdout.write(`trust-layer listening on http://${host}:${port}/mcp\n`); });
}

if (process.argv[1] && (process.argv[1].endsWith("server.ts") || process.argv[1].endsWith("server.js"))) {
  void startFromEnvironment().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown startup failure";
    process.stderr.write(`trust-layer startup failed: ${message}\n`);
    process.exitCode = 1;
  });
}
