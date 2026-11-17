import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { basename, dirname, join } from "node:path";
// Package self-imports (not "./x.js"): the desktop host loads these .ts sources directly at runtime.
import { CompanionHttpServer, type CompanionOutputSource, type CompanionReadModel } from "@nexus/integration/companion-http";
import { resolveBind, type CompanionNetworkConfig, type NetworkInterfaceLike } from "@nexus/integration/companion-network";
import { CompanionPolicy } from "@nexus/integration/companion-policy";
import { HostEnrollmentRegistry } from "@nexus/integration/host-enrollment";

export interface CompanionServiceOptions {
  hostId: string;
  displayName: string;
  readModel: CompanionReadModel;
  outputSource?: CompanionOutputSource;
  /** Where to write the user-only credentials file. Omit to skip writing one. */
  credentialsPath?: string;
  port?: number;
  /** Reachability (default: local, loopback only). See companion-network.ts. */
  network?: CompanionNetworkConfig;
  /** Test seam: defaults to the machine's real interfaces. */
  interfaces?: Record<string, readonly NetworkInterfaceLike[] | undefined>;
}

export interface CompanionServiceInfo {
  mode: "local" | "private" | "https";
  url: string;
  hostId: string;
  /** Raw enrollment token. Handed to the caller once; only a salted hash is kept in memory. */
  enrollmentToken: string;
  /** Set only when the file was written AND restricted to the current user. */
  credentialsPath: string | null;
  credentialsWarning: string | null;
}

export interface CompanionService {
  info: CompanionServiceInfo;
  stop(): Promise<void>;
}

/**
 * Starts the loopback-only read-only companion with a fresh single-user enrollment. The registry is
 * in memory, so the token is valid for this run only and is regenerated on every start.
 */
export async function startCompanionService(options: CompanionServiceOptions): Promise<CompanionService> {
  const network: CompanionNetworkConfig = options.network ?? { mode: "local" };
  const resolved = resolveBind(options.port === undefined ? network : { ...network, port: options.port }, options.interfaces ?? networkInterfaces());
  const tls = network.mode === "https"
    ? { cert: readFileSync(network.certFile), key: readFileSync(network.keyFile) }
    : undefined;
  const enrollment = new HostEnrollmentRegistry();
  const issued = enrollment.enroll(options.hostId, options.displayName, new Date().toISOString());
  const server = new CompanionHttpServer(new CompanionPolicy(enrollment), {
    readModel: options.readModel,
    ...(options.outputSource === undefined ? {} : { outputSource: options.outputSource }),
    mode: resolved.mode,
    bind: resolved.bind,
    port: resolved.port,
    ...(tls === undefined ? {} : { tls }),
  });
  const address = await server.start();
  const url = network.mode === "https"
    ? `https://${network.publicHost}:${address.port}`
    : `http://${address.host.includes(":") ? `[${address.host}]` : address.host}:${address.port}`;
  let credentialsPath: string | null = null;
  let credentialsWarning: string | null = null;
  if (options.credentialsPath) {
    try {
      writeUserOnlyFile(options.credentialsPath, JSON.stringify({
        note: "NEXUS companion credentials. Valid until the desktop app exits; regenerated on next launch. Keep private.",
        url,
        hostId: issued.host.hostId,
        enrollmentToken: issued.enrollmentToken,
        howTo: [
          `POST ${url}/v1/companion/authorize with JSON {hostId, clientId, enrollmentToken, capability: "read-workspace"} to get a short-lived grant.`,
          `GET ${url}/v1/companion/hosts/${issued.host.hostId}/sessions with headers "Authorization: Bearer <grantId>" and "X-Nexus-Client-Id: <clientId>".`,
          `For terminal output, authorize with capability "attach-read" instead, then GET ${url}/v1/companion/hosts/${issued.host.hostId}/sessions/<sessionId>/output (read-only, last 64 KiB; output may contain sensitive text).`,
        ],
      }, null, 2) + "\n");
      credentialsPath = options.credentialsPath;
    } catch (error) {
      credentialsWarning = `credentials file not written: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return {
    info: { mode: resolved.mode, url, hostId: issued.host.hostId, enrollmentToken: issued.enrollmentToken, credentialsPath, credentialsWarning },
    stop: () => server.stop(),
  };
}

/**
 * Replaces any existing file (refusing symlinks/junctions), creates it exclusively and empty,
 * restricts it to the current user, reads the ACL back to confirm, and only then writes the secret.
 * Throws (leaving the file empty) if it cannot confirm the restriction.
 */
function writeUserOnlyFile(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const existing = lstatSync(file, { throwIfNoEntry: false });
  if (existing) {
    if (existing.isSymbolicLink()) throw new Error("credentials path is a link; refusing");
    unlinkSync(file);
  }
  writeFileSync(file, "", { flag: "wx", mode: 0o600 });
  if (process.platform === "win32") {
    const [account, sid] = currentWindowsUser();
    execFileSync(system32("icacls.exe"), [file, "/inheritance:r", "/grant:r", `*${sid}:F`], { stdio: "ignore" });
    const listing = execFileSync(system32("icacls.exe"), [file], { encoding: "utf8" });
    if (!aclIsRestricted(listing, file, account)) {
      // The listing is ACL metadata only (no secrets); it is included so a failure is diagnosable.
      throw new Error("could not confirm user-only permissions (expected " + JSON.stringify(account) + ", icacls said " + JSON.stringify(listing.slice(0, 400)) + ")");
    }
  } else {
    chmodSync(file, 0o600);
    if ((statSync(file).mode & 0o077) !== 0) throw new Error("could not confirm user-only permissions");
  }
  writeFileSync(file, contents);
}

/**
 * True only if every ACE in the icacls listing belongs to `account` or to SYSTEM / Administrators, and
 * `account` itself is present. SYSTEM and Administrators are tolerated because an elevated token's default
 * DACL adds them and they can take ownership of any file regardless; any other principal (Everyone, Users,
 * Authenticated Users, another account) fails closed.
 */
export function aclIsRestricted(icaclsOutput: string, file: string, account: string): boolean {
  const listing = icaclsOutput.split("Successfully processed")[0] ?? "";
  // icacls may print the long form of the path (e.g. RUNNER~1 -> runneradmin), so locate the file by
  // its final path component on the first line rather than by the full path we passed in.
  const baseName = basename(file.replaceAll("\\", "/")).toLowerCase();
  const lines = listing.split(/\r?\n/);
  const firstLine = lines[0] ?? "";
  const at = firstLine.toLowerCase().lastIndexOf(baseName);
  if (baseName.length === 0 || at < 0) return false;
  const entries = [firstLine.slice(at + baseName.length), ...lines.slice(1)].map((line) => line.trim()).filter((line) => line.length > 0);
  const allowed = new Set([account.toLowerCase(), "nt authority\\system", "builtin\\administrators"]);
  let sawAccount = false;
  for (const entry of entries) {
    const match = entry.match(/^(.+?):\(/);
    if (!match) return false;
    const principal = (match[1] ?? "").toLowerCase();
    if (!allowed.has(principal)) return false;
    if (principal === account.toLowerCase()) sawAccount = true;
  }
  return sawAccount;
}

/** Current account name and SID from the OS (not from environment variables). */
function currentWindowsUser(): [string, string] {
  const out = execFileSync(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).trim();
  const m = out.match(/^"([^"]+)","(S-1-[0-9-]+)"$/);
  if (!m) throw new Error("cannot determine current user");
  return [m[1]!, m[2]!];
}

/** Absolute System32 path: avoids a Unix-style `whoami` (Git for Windows) or a planted binary earlier on PATH. */
function system32(exe: string): string {
  return join(process.env.SystemRoot ?? "C:/Windows", "System32", exe);
}
