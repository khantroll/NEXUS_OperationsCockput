import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { isIP } from "node:net";
import type { CompanionPolicy } from "./companion-policy.js";
// Package self-import (value): the desktop host loads these .ts sources directly at runtime.
import { isPrivateAddress, peerAllowed } from "@nexus/integration/companion-network";

const maxBodyBytes = 16 * 1024;
const maxAuthAttemptsPerMinute = 5;
const maxAuthAttemptsPerMinuteTotal = 20; // across all sources, checked before any expensive token hash
const maxConnectionsPerSource = 8;

export interface CompanionHttpOptions {
  /** Reachability mode. Default "local" (loopback only). "private" needs a private bind; "https" needs `tls`. */
  mode?: "local" | "private" | "https";
  /** Address to listen on. Local: loopback. Private: a private/CGNAT address. Https: any address (default 0.0.0.0). */
  bind?: string;
  /** Required (and only allowed) for mode "https". */
  tls?: { cert: string | Buffer; key: string | Buffer };
  /** @deprecated use `bind`. */
  host?: "127.0.0.1" | "::1";
  port?: number;
  readModel?: CompanionReadModel;
  /** Read-only terminal output for `attach-read` grants. Absent means the output endpoint is disabled. */
  outputSource?: CompanionOutputSource;
}

/** Supplies bounded, read-only terminal output; returns null for an unknown session or host. */
export interface CompanionOutputSource {
  readOutput(hostId: string, sessionId: string, maxBytes: number): string | null;
}

const maxOutputBytes = 64 * 1024;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

/** HTTP(S) transport for the authenticated read-only companion policy. Loopback-only unless configured otherwise. */
export class CompanionHttpServer {
  private readonly server: Server;
  private readonly mode: "local" | "private" | "https";
  private address: CompanionHttpAddress | null = null;
  private readonly openPerSource = new Map<string, number>();
  private globalAuth = { windowStartedAt: 0, count: 0 };
  private readonly authAttempts = new Map<string, { windowStartedAt: number; count: number }>();

  private readonly policy: CompanionPolicy;
  private readonly options: CompanionHttpOptions;

  // No parameter properties: the desktop host runs this file under Node's strip-only TypeScript mode.
  public constructor(policy: CompanionPolicy, options: CompanionHttpOptions = {}) {
    this.policy = policy;
    this.options = options;
    this.mode = options.mode ?? "local";
    const listener = (request: IncomingMessage, response: ServerResponse): void => { void this.handle(request, response); };
    if (this.mode === "https") {
      if (!options.tls) throw new Error("https mode requires a TLS certificate and key");
      this.server = createTlsServer({ cert: options.tls.cert, key: options.tls.key, minVersion: "TLSv1.2", handshakeTimeout: 5_000, connectionsCheckingInterval: 2_000 } as Parameters<typeof createTlsServer>[0], listener);
    } else {
      if (options.tls) throw new Error("TLS is only used in https mode");
      this.server = createServer({ connectionsCheckingInterval: 2_000 }, listener);
    }
    // Slow or idle clients must not be able to hold sockets open; remote modes also cap concurrent connections.
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 15_000;
    this.server.keepAliveTimeout = 5_000;
    this.server.timeout = 20_000;
    if (this.mode !== "local") {
      this.server.maxConnections = 64;
      // Refuse disallowed peers at connect time (before TLS/HTTP parsing) and cap sockets per source.
      this.server.on("connection", (socket) => {
        const remote = socket.remoteAddress;
        if (!peerAllowed(this.mode, remote)) { socket.destroy(); return; }
        const key = sourceKey(remote);
        const open = this.openPerSource.get(key) ?? 0;
        if (open >= maxConnectionsPerSource) { socket.destroy(); return; }
        this.openPerSource.set(key, open + 1);
        socket.once("close", () => {
          const left = (this.openPerSource.get(key) ?? 1) - 1;
          if (left <= 0) this.openPerSource.delete(key); else this.openPerSource.set(key, left);
        });
      });
      this.server.on("tlsClientError", (_error, socket) => { socket.destroy(); });
    }
  }

  public async start(): Promise<CompanionHttpAddress> {
    if (this.address) return this.address;
    const host = this.options.bind ?? this.options.host ?? (this.mode === "https" ? "0.0.0.0" : "127.0.0.1");
    const port = this.options.port ?? 0;
    if (isIP(host) === 0) throw new Error("companion bind must be an IP address");
    if (this.mode === "local" && host !== "127.0.0.1" && host !== "::1") throw new Error("companion server must bind to loopback");
    if (this.mode === "private" && !isPrivateAddress(host)) throw new Error("private mode must bind to a private/Tailscale/WireGuard address, not " + host);
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
    this.address = null;
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    if (request.method === "GET" && request.url === "/health") {
      writeJson(response, 200, { ok: true, mode: this.mode === "local" ? "loopback" : this.mode });
      return;
    }
    const outputPath = request.url?.match(/^\/v1\/companion\/hosts\/([^/]+)\/sessions\/([^/]+)\/output$/);
    if (request.method === "GET" && outputPath) {
      this.handleOutput(request, response, outputPath[1] ?? "", outputPath[2] ?? "");
      return;
    }
    const sessionPath = request.url?.match(/^\/v1\/companion\/hosts\/([^/]+)\/sessions$/);
    if (request.method === "GET" && sessionPath) {
      if (!this.options.readModel || !peerAllowed(this.mode, request.socket.remoteAddress)) {
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
    if (!peerAllowed(this.mode, request.socket.remoteAddress)) {
      writeJson(response, 403, { error: this.mode === "local" ? "loopback-required" : "private-network-required" });
      return;
    }
    const source = sourceKey(request.socket.remoteAddress);
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
      const result = this.policy.authorize({ ...body, network: this.mode === "https" ? "tls" : "private" }, new Date().toISOString());
      writeJson(response, result.accepted ? 200 : 401, result);
    } catch (error) {
      writeJson(response, 400, { error: error instanceof Error && error.message === "request body too large" ? "request body too large" : "invalid-request" });
    }
  }

  /** `attach-read`: bounded tail of a session's terminal output. Read-only; there is no input route. */
  private handleOutput(request: IncomingMessage, response: ServerResponse, rawHost: string, rawSession: string): void {
    const source = this.options.outputSource;
    if (!source || !peerAllowed(this.mode, request.socket.remoteAddress)) {
      writeJson(response, 403, { error: "output-unavailable" });
      return;
    }
    let hostId: string;
    let sessionId: string;
    try {
      hostId = decodeURIComponent(rawHost);
      sessionId = decodeURIComponent(rawSession);
    } catch {
      writeJson(response, 400, { error: "invalid-id" });
      return;
    }
    if (!idPattern.test(hostId) || !idPattern.test(sessionId)) {
      writeJson(response, 400, { error: "invalid-id" });
      return;
    }
    const clientId = request.headers["x-nexus-client-id"];
    const authorization = request.headers.authorization;
    const grantId = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
    if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > 128 || !grantId || grantId.length > 128 ||
      !this.policy.validateGrant(grantId, hostId, clientId, "attach-read", new Date().toISOString())) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    let output: string | null;
    try {
      output = source.readOutput(hostId, sessionId, maxOutputBytes);
    } catch {
      output = null;
    }
    if (output === null) {
      writeJson(response, 404, { error: "unknown-session" });
      return;
    }
    // Enforce the bound here too, so a misbehaving source cannot return unbounded output.
    const bytes = Buffer.from(output, "utf8");
    const truncated = bytes.length > maxOutputBytes;
    let start = truncated ? bytes.length - maxOutputBytes : 0;
    // Do not begin mid-character: skip UTF-8 continuation bytes (10xxxxxx).
    while (truncated && start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
    writeJson(response, 200, { sessionId, truncated, output: truncated ? bytes.subarray(start).toString("utf8") : output });
  }

  private consumeAuthBudget(source: string): boolean {
    const now = Date.now();
    // Global ceiling first: token verification is deliberately expensive, so total attempts are bounded no
    // matter how many source addresses an attacker has.
    if (now - this.globalAuth.windowStartedAt >= 60_000) this.globalAuth = { windowStartedAt: now, count: 0 };
    if (this.globalAuth.count >= maxAuthAttemptsPerMinuteTotal) return false;
    if (this.authAttempts.size > 4096) {
      for (const [key, value] of this.authAttempts) if (now - value.windowStartedAt >= 60_000) this.authAttempts.delete(key);
    }
    const current = this.authAttempts.get(source);
    if (current && now - current.windowStartedAt < 60_000) {
      if (current.count >= maxAuthAttemptsPerMinute) return false;
      current.count += 1;
    } else {
      if (this.authAttempts.size > 4096) return false; // many fresh sources at once: shed load rather than grow
      this.authAttempts.set(source, { windowStartedAt: now, count: 1 });
    }
    this.globalAuth.count += 1;
    return true;
  }
}

/** Rate-limit/connection key: IPv4-mapped addresses collapse to IPv4; IPv6 is grouped by /64 (one subscriber can own the whole prefix). */
function sourceKey(address: string | undefined): string {
  if (!address) return "unknown";
  const normalized = address.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "").replace(/%.*$/, "");
  if (isIP(normalized) !== 6) return normalized;
  const groups = normalized.includes("::") ? expandV6(normalized) : normalized.split(":");
  return groups.slice(0, 4).join(":");
}

function expandV6(address: string): string[] {
  const [head = "", tail = ""] = address.split("::");
  const a = head ? head.split(":") : [];
  const b = tail ? tail.split(":") : [];
  return [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b];
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.end(JSON.stringify(value));
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
