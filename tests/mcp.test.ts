import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { request, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { MutableClock } from "../src/clock.js";
import { OAuthService } from "../src/oauth.js";
import { createHttpServer } from "../src/server.js";
import { TrustLayerService } from "../src/service.js";

interface HttpResponse { status: number; headers: Record<string, string | string[] | undefined>; body: unknown; }
interface InputUsageState { all: string[]; invalid: string[]; cooldownUntil: string | null; }
type HttpEndpoint = { mode: "tcp"; port: number } | { mode: "in-process"; listener: RequestListener };

class InProcessResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  readonly headers: Record<string, string | string[] | undefined> = {};
  private readonly chunks: Buffer[] = [];
  ended = false;

  setHeader(name: string, value: number | string | readonly string[]): void {
    if (typeof value === "number") this.headers[name.toLowerCase()] = String(value);
    else if (Array.isArray(value)) this.headers[name.toLowerCase()] = [...value] as string[];
    else this.headers[name.toLowerCase()] = value as string;
  }

  writeHead(status: number, headers: Record<string, unknown> = {}): this {
    this.statusCode = status;
    this.headersSent = true;
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === "number" || typeof value === "string" || Array.isArray(value)) this.setHeader(name, value as number | string | string[]);
    }
    return this;
  }

  flushHeaders(): void { this.headersSent = true; }

  write(chunk: string | Buffer): boolean { this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true; }

  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) this.write(chunk);
    this.headersSent = true;
    this.ended = true;
    this.emit("finish");
    return this;
  }

  body(): unknown {
    const text = Buffer.concat(this.chunks).toString("utf8");
    try { return JSON.parse(text); } catch { return text; }
  }
}

async function startHttpEndpoint(server: ReturnType<typeof createHttpServer>): Promise<HttpEndpoint> {
  return new Promise((resolve) => {
    const onError = () => {
      server.removeListener("error", onError);
      resolve({ mode: "in-process", listener: server.listeners("request")[0] as RequestListener });
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ mode: "tcp", port });
    });
  });
}

function post(endpoint: HttpEndpoint, body: unknown, token: string, sessionId?: string): Promise<HttpResponse> {
  if (endpoint.mode === "in-process") return postInProcess(endpoint.listener, body, token, sessionId);
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request({ hostname: "127.0.0.1", port: endpoint.port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...(sessionId ? { "mcp-session-id": sessionId } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* Streamable transport may return an event stream. */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed });
      });
    });
    req.on("error", reject); req.end(payload);
  });
}

async function postInProcess(listener: RequestListener, body: unknown, token: string, sessionId?: string): Promise<HttpResponse> {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(req, {
    method: "POST",
    url: "/mcp",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
  });
  const response = new InProcessResponse();
  const finished = new Promise<void>((resolve, reject) => { response.once("finish", resolve); response.once("error", reject); });
  await listener(req, response as unknown as ServerResponse);
  if (!response.ended) await finished;
  return { status: response.statusCode, headers: response.headers, body: response.body() };
}

function objectAt(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || typeof (value as Record<string, unknown>)[key] !== "object" || (value as Record<string, unknown>)[key] === null) throw new Error(`expected object at ${key}`);
  return (value as Record<string, Record<string, unknown>>)[key];
}

function inputUsageOf(service: TrustLayerService): InputUsageState[] {
  const state = (service as unknown as { state: { inputUsage: Record<string, InputUsageState> } }).state;
  return Object.values(state.inputUsage);
}

describe("Streamable HTTP MCP contract", () => {
  let httpServer: ReturnType<typeof createHttpServer> | undefined;
  afterEach(async () => { if (httpServer?.listening) await new Promise<void>((resolve) => httpServer!.close(() => resolve())); httpServer = undefined; });

  it("publishes five tools and returns structured success/error through OAuth", async () => {
    const service = new TrustLayerService({ dbFile: null, clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "mcp-http" });
    const oauth = new OAuthService(service.database, { publicBaseUrl: "http://localhost", issuer: "http://localhost", signingSecret: "oauth-test-signing-secret-32-chars!", operatorUsername: "operator", operatorPassword: "operator-password" });
    const token = oauth.issueTestAccessToken("operator");
    httpServer = createHttpServer(service, oauth);
    const port = await startHttpEndpoint(httpServer);
    const initialize = await post(port, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "trust-layer-test", version: "0.3" } } }, token);
    expect(initialize.status).toBe(200);
    const sessionId = initialize.headers["mcp-session-id"];
    expect(typeof sessionId).toBe("string");
    const listed = await post(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, token, sessionId as string);
    expect(listed.status).toBe(200);
    const toolsValue = objectAt(listed.body, "result").tools;
    expect(Array.isArray(toolsValue)).toBe(true);
    expect((toolsValue as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["report_domain_assessment", "report_domain_assessments_batch", "report_research_manifest", "submit_local_verification", "lookup_domain_signal"]);

    const called = await post(port, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "report_domain_assessment", arguments: { research_id: "11111111-1111-4111-8111-111111111111", collection_mode: "minimal_observation", rubric_version: "0.3", domain: "example.com", outcome: "used_as_support", reason_code: "direct_evidence", agent_model_name: "openai_gpt5" } } }, token, sessionId as string);
    expect(called.status).toBe(200);
    expect(objectAt(objectAt(called.body, "result"), "structuredContent")).toMatchObject({ ok: true, code: "accepted" });
  });

  it("sanitizes omitted arguments for strict tools and preserves batch validation", async () => {
    const service = new TrustLayerService({ dbFile: null, clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "mcp-omitted-arguments" });
    const oauth = new OAuthService(service.database, { publicBaseUrl: "http://localhost", issuer: "http://localhost", signingSecret: "oauth-test-signing-secret-32-chars!", operatorUsername: "operator", operatorPassword: "operator-password" });
    const token = oauth.issueTestAccessToken("operator");
    httpServer = createHttpServer(service, oauth);
    const port = await startHttpEndpoint(httpServer);
    const initialize = await post(port, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "trust-layer-omitted-arguments-test", version: "0.3" } } }, token);
    const sessionId = initialize.headers["mcp-session-id"] as string;
    const strictTools = ["report_domain_assessment", "report_research_manifest", "submit_local_verification", "lookup_domain_signal"];
    for (const [index, name] of strictTools.entries()) {
      const response = await post(port, { jsonrpc: "2.0", id: index + 2, method: "tools/call", params: { name } }, token, sessionId);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ jsonrpc: "2.0", id: index + 2, error: { code: -32602, message: "Invalid tool arguments" } });
      expect(response.body).not.toHaveProperty("result");
      expect(JSON.stringify(response.body)).not.toMatch(/"(?:path|expected|invalid_type|received)"/);
    }

    const batchResponse = await post(port, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "report_domain_assessments_batch" } }, token, sessionId);
    const batchStructured = objectAt(objectAt(batchResponse.body, "result"), "structuredContent");
    expect(batchStructured).toMatchObject({ ok: false, code: "invalid_schema" });
    expect(JSON.stringify(batchResponse.body)).not.toMatch(/"(?:path|expected|invalid_type|received)"/);
  }, 15000);

  it("returns sanitized Invalid params for protocol-invalid tool arguments and lets service handle outer-invalid batches", async () => {
    const service = new TrustLayerService({ dbFile: null, clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "mcp-batch-boundary" });
    const oauth = new OAuthService(service.database, { publicBaseUrl: "http://localhost", issuer: "http://localhost", signingSecret: "oauth-test-signing-secret-32-chars!", operatorUsername: "operator", operatorPassword: "operator-password" });
    const token = oauth.issueTestAccessToken("operator");
    httpServer = createHttpServer(service, oauth);
    const port = await startHttpEndpoint(httpServer);
    const initialize = await post(port, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "trust-layer-boundary-test", version: "0.3" } } }, token);
    const sessionId = initialize.headers["mcp-session-id"] as string;
    const protocolInvalidArguments = [[], "not-an-object", 42, null];
    for (const [index, argumentsValue] of protocolInvalidArguments.entries()) {
      const protocolInvalid = await post(port, { jsonrpc: "2.0", id: index + 2, method: "tools/call", params: { name: "report_domain_assessments_batch", arguments: argumentsValue } }, token, sessionId);
      const protocolError = objectAt(protocolInvalid.body, "error");
      expect(protocolInvalid.status).toBe(200);
      expect(protocolError).toEqual({ code: -32602, message: "Invalid tool arguments" });
      expect(protocolInvalid.body).not.toHaveProperty("result");
      expect(JSON.stringify(protocolInvalid.body)).not.toMatch(/"(?:path|expected|invalid_type|received)"/);
    }

    const malformedCalls = [
      { unexpected: true },
      {},
      { assessments: "not-an-array" },
      { assessments: [] },
      { assessments: Array.from({ length: 6 }, () => ({})) },
    ];
    for (const [index, argumentsValue] of malformedCalls.entries()) {
      const response = await post(port, { jsonrpc: "2.0", id: index + protocolInvalidArguments.length + 2, method: "tools/call", params: { name: "report_domain_assessments_batch", arguments: argumentsValue } }, token, sessionId);
      const structured = objectAt(objectAt(response.body, "result"), "structuredContent");
      expect(structured).toMatchObject(index === malformedCalls.length - 1
        ? { ok: false, code: "invalid_schema", retry_directive: "fix_request_then_retry_after_delay", retry_after_seconds: 600 }
        : { ok: false, code: "invalid_schema" });
    }
  }, 15000);

  it("rejects chunked MCP bodies over 64 KiB before service accounting", async () => {
    const service = new TrustLayerService({ dbFile: null, clock: new MutableClock("2026-08-24T00:00:00Z"), secret: "mcp-body-limit" });
    const oauth = new OAuthService(service.database, { publicBaseUrl: "http://localhost", issuer: "http://localhost", signingSecret: "oauth-test-signing-secret-32-chars!", operatorUsername: "operator", operatorPassword: "operator-password" });
    const token = oauth.issueTestAccessToken("operator");
    httpServer = createHttpServer(service, oauth);
    const port = await startHttpEndpoint(httpServer);
    const initialize = await post(port, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "trust-layer-size-test", version: "0.3" } } }, token);
    const sessionId = initialize.headers["mcp-session-id"] as string;
    const oversized = await post(port, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "report_domain_assessments_batch", arguments: { assessments: ["x".repeat(70 * 1024)] } } }, token, sessionId);
    expect([400, 413]).toContain(oversized.status);
    expect(inputUsageOf(service)).toEqual([]);
    const valid = await post(port, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "report_domain_assessments_batch", arguments: { assessments: [{ research_id: "22222222-2222-4222-8222-222222222222", collection_mode: "minimal_observation", rubric_version: "0.3", domain: "after-size-limit.example.com", outcome: "used_as_support", reason_code: "direct_evidence", agent_model_name: "openai_gpt5" }] } } }, token, sessionId);
    expect(objectAt(objectAt(valid.body, "result"), "structuredContent")).toMatchObject({ ok: true, accepted_count: 1 });
    const usageAfterValid = inputUsageOf(service);
    expect(usageAfterValid).toHaveLength(1);
    expect(usageAfterValid[0].all).toHaveLength(1);
  }, 15000);
});
