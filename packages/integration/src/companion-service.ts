import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
// Package self-imports (not "./x.js"): the desktop host loads these .ts sources directly at runtime.
import { CompanionHttpServer, type CompanionOutputSource, type CompanionReadModel } from "@nexus/integration/companion-http";
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
}

export interface CompanionServiceInfo {
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
  const enrollment = new HostEnrollmentRegistry();
  const issued = enrollment.enroll(options.hostId, options.displayName, new Date().toISOString());
  const server = new CompanionHttpServer(new CompanionPolicy(enrollment), {
    readModel: options.readModel,
    ...(options.outputSource === undefined ? {} : { outputSource: options.outputSource }),
    ...(options.port === undefined ? {} : { port: options.port }),
  });
  const address = await server.start();
  const url = `http://${address.host}:${address.port}`;
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
    info: { url, hostId: issued.host.hostId, enrollmentToken: issued.enrollmentToken, credentialsPath, credentialsWarning },
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
    if (!aclIsOnly(execFileSync(system32("icacls.exe"), [file], { encoding: "utf8" }), file, account)) {
      throw new Error("could not confirm user-only permissions");
    }
  } else {
    chmodSync(file, 0o600);
    if ((statSync(file).mode & 0o077) !== 0) throw new Error("could not confirm user-only permissions");
  }
  writeFileSync(file, contents);
}

/** True only if the icacls listing contains exactly one ACE and it belongs to `account`. Fails closed. */
export function aclIsOnly(icaclsOutput: string, file: string, account: string): boolean {
  const listing = icaclsOutput.split("Successfully processed")[0] ?? "";
  // icacls may print the long form of the path (e.g. RUNNER~1 -> runneradmin), so locate the file by
  // its final path component on the first line rather than by the full path we passed in.
  const baseName = basename(file.replaceAll("\\", "/")).toLowerCase();
  const firstLine = listing.split(/\r?\n/)[0] ?? "";
  const at = firstLine.toLowerCase().lastIndexOf(baseName);
  if (baseName.length === 0 || at < 0) return false;
  const aces = (firstLine.slice(at + baseName.length) + "\n" + listing.split(/\r?\n/).slice(1).join("\n")).trim();
  return aces.toLowerCase().startsWith(`${account.toLowerCase()}:(`) && (aces.match(/:\(/g) ?? []).length === 1;
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
