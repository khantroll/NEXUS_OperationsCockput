import path from "node:path";

// Loaded by the desktop host under Node's strip-only TypeScript mode: no parameter properties, enums,
// or relative ".js" value imports in this file.

/**
 * Non-secret SSH launcher metadata. No passwords, passphrases, or key material: authentication is left
 * to ssh itself (agent, key file, or an interactive prompt inside the PTY).
 */
export interface SshProfileRecord {
  profileId: string;
  name: string;
  /** Hostname, IPv4/IPv6 address, or a Host alias from the user's ~/.ssh/config. */
  host: string;
  user?: string;
  port?: number;
  /** Absolute path to a private key file (the path only, never its contents). */
  identityFile?: string;
  /** If set, attach to (or create) this tmux session on the remote host so it survives disconnects. */
  remoteTmuxSession?: string;
}

export interface ResolvedSshProfile {
  file: string;
  args: string[];
}

const hostPattern = /^[A-Za-z0-9_](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9_])?$/;
const ipv6Pattern = /^[0-9A-Fa-f:]{2,45}$/;
const userPattern = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const tmuxNamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const profileIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Throws a descriptive error unless the value is a well-formed SSH profile. */
export function assertSshProfile(value: unknown): asserts value is SshProfileRecord {
  if (typeof value !== "object" || value === null) throw new Error("SSH profile must be an object");
  const p = value as Record<string, unknown>;
  if (typeof p.profileId !== "string" || !profileIdPattern.test(p.profileId)) throw new Error("invalid profileId");
  if (typeof p.name !== "string" || p.name.trim().length === 0 || p.name.length > 100) throw new Error("invalid name");
  if (typeof p.host !== "string" || !(hostPattern.test(p.host) || ipv6Pattern.test(p.host))) throw new Error("invalid host");
  if (p.user !== undefined && (typeof p.user !== "string" || !userPattern.test(p.user))) throw new Error("invalid user");
  if (p.port !== undefined && (typeof p.port !== "number" || !Number.isInteger(p.port) || p.port < 1 || p.port > 65_535)) throw new Error("invalid port");
  if (p.identityFile !== undefined && (typeof p.identityFile !== "string" || !path.isAbsolute(p.identityFile) || p.identityFile.includes("\u0000") || p.identityFile.length > 1024)) {
    throw new Error("invalid identityFile: must be an absolute path");
  }
  if (p.remoteTmuxSession !== undefined && (typeof p.remoteTmuxSession !== "string" || !tmuxNamePattern.test(p.remoteTmuxSession))) {
    throw new Error("invalid remoteTmuxSession");
  }
}

/**
 * Resolves a profile to an ssh argv. Host-key checking stays at ssh's defaults (it is never disabled),
 * and every caller-controlled value is validated above, so nothing can start with "-" or carry shell
 * metacharacters into the (remote) tmux command.
 */
export function resolveSshProfile(profile: SshProfileRecord, platform: string = process.platform, environment: NodeJS.ProcessEnv = process.env): ResolvedSshProfile {
  assertSshProfile(profile);
  const args: string[] = [
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
  ];
  if (profile.port !== undefined) args.push("-p", String(profile.port));
  if (profile.user !== undefined) args.push("-l", profile.user);
  if (profile.identityFile !== undefined) args.push("-i", profile.identityFile);
  if (profile.remoteTmuxSession !== undefined) args.push("-t");
  args.push("--", profile.host);
  if (profile.remoteTmuxSession !== undefined) args.push("tmux", "new-session", "-A", "-s", `nexus-${profile.remoteTmuxSession}`);
  return { file: sshExecutable(platform, environment), args };
}

function sshExecutable(platform: string, environment: NodeJS.ProcessEnv): string {
  // Prefer the OS-provided OpenSSH by absolute path so a binary earlier on PATH cannot shadow it.
  if (platform === "win32") return path.join(environment.SystemRoot ?? "C:/Windows", "System32", "OpenSSH", "ssh.exe");
  return "ssh";
}
