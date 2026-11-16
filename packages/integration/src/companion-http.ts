import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { CompanionPolicy } from "./companion-policy.js";

const maxBodyBytes = 16 * 1024;
const maxAuthAttemptsPerMinute = 5;

export interface CompanionHttpOptions {
  host?: "127.0.0.1" | "::1";
  port?: number;
  readModel?: CompanionReadModel;
}

export interface CompanionSessionView {
  sessionId: string;
  kind: "local-pty" | "ssh-pty" | "browser" | "vnc" | "rdp" | "external-link";
  process: "starting" | "running" | "exited" | "failed" | "unknown";
  transport: "connected" | "reconnecting" | "disconnected" | "unavailable";
}

export interface CompanionReadModel {
  listSessions(hostId: string): readonly CompanionSessionView[];
}

export interface CompanionHttpAddress {
  host: string;
  port: number;
}

/** Loopback-only HTTP transport for the authenticated read-only companion policy. */
export class CompanionHttpServer {
  private readonly server: Server;
  private address: CompanionHttpAddress | null = null;
  private readonly authAttempts = new Map<string, { windowStartedAt: number; count: number }>();

  public constructor(private readonly policy: CompanionPolicy, private readonly options: CompanionHttpOptions = {}) {
    this.server = createServer((request, response) => { void this.handle(request, response); });
  }

  public async start(): Promise<CompanionHttpAddress> {
    if (this.address) return this.address;
    const host = this.options.host ?? "127.0.0.1";
    const port = this.options.port ?? 0;
    if (host !== "127.0.0.1" && host !== "::1") throw new Error("companion server must bind to loopback");
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("invalid companion port");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { this.server.off("listening", onListening); reject(error); };
      const onListening = (): void => { this.server.off("error", onError); resolve(); };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(port, host);
    });
    const bound = this.server.address();
    if (!bound || typeof bound === "string") throw new Error("companion server did not expose a TCP address");
    this.address = { host, port: bound.port };
    return this.address;
  }

  public async stop(): Promise<void> {
    if (!this.address) return;
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    this.address = null;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    if (request.method === "GET" && request.url === "/health") {
      writeJson(response, 200, { ok: true, mode: "loopback" });
      return;
    }
    const sessionPath = request.url?.match(/^\/v1\/companion\/hosts\/([^/]+)\/sessions$/);
    if (request.method === "GET" && sessionPath) {
      if (!this.options.readModel || !isLoopback(request.socket.remoteAddress)) {
        writeJson(response, 403, { error: "session-read-unavailable" });
        return;
      }
      const clientId = request.headers["x-nexus-client-id"];
      const authorization = request.headers.authorization;
      const grantId = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
      let hostId: string;
      try {
        hostId = decodeURIComponent(sessionPath[1] ?? "");
      } catch {
        writeJson(response, 400, { error: "invalid-host-id" });
        return;
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(hostId)) {
        writeJson(response, 400, { error: "invalid-host-id" });
        return;
      }
      if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > 128 || !grantId || grantId.length > 128 ||
        !this.policy.validateGrant(grantId, hostId, clientId, "read-workspace", new Date().toISOString())) {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }
      writeJson(response, 200, { sessions: this.options.readModel.listSessions(hostId).flatMap(redactSession) });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/companion/authorize") {
      writeJson(response, 404, { error: "not-found" });
      return;
    }
    if (!isLoopback(request.socket.remoteAddress)) {
      writeJson(response, 403, { error: "private-network-required" });
      return;
    }
    const source = request.socket.remoteAddress ?? "unknown";
    if (!this.consumeAuthBudget(source)) {
      writeJson(response, 429, { error: "rate-limited" });
      return;
    }
    const declaredLength = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      writeJson(response, 413, { error: "request body too large" });
      return;
    }
    try {
      const body = await readJson(request);
      const result = this.policy.authorize({ ...body, network: "private" }, new Date().toISOString());
      writeJson(response, result.accepted ? 200 : 401, result);
    } catch (error) {
      writeJson(response, 400, { error: error instanceof Error ? error.message : "invalid-request" });
    }
  }

  private consumeAuthBudget(source: string): boolean {
    const now = Date.now();
    const current = this.authAttempts.get(source);
    if (!current || now - current.windowStartedAt >= 60_000) {
      this.authAttempts.set(source, { windowStartedAt: now, count: 1 });
      return true;
    }
    if (current.count >= maxAuthAttemptsPerMinute) return false;
    current.count += 1;
    return true;
  }
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.end(JSON.stringify(value));
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  if (address === "::1" || address === "127.0.0.1") return true;
  if (isIP(address) === 6 && address.startsWith("::ffff:127.")) return true;
  return false;
}

function redactSession(value: CompanionSessionView): CompanionSessionView | [] {
  if (typeof value !== "object" || value === null ||
    typeof value.sessionId !== "string" || !isSessionKind(value.kind) ||
    !isProcessState(value.process) || !isTransportState(value.transport)) return [];
  return { sessionId: value.sessionId, kind: value.kind, process: value.process, transport: value.transport };
}

function isSessionKind(value: unknown): value is CompanionSessionView["kind"] {
  return value === "local-pty" || value === "ssh-pty" || value === "browser" || value === "vnc" || value === "rdp" || value === "external-link";
}

function isProcessState(value: unknown): value is CompanionSessionView["process"] {
  return value === "starting" || value === "running" || value === "exited" || value === "failed" || value === "unknown";
}

function isTransportState(value: unknown): value is CompanionSessionView["transport"] {
  return value === "connected" || value === "reconnecting" || value === "disconnected" || value === "unavailable";
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBodyBytes) throw new Error("request body too large");
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("request body must be an object");
  return parsed as Record<string, unknown>;
}
