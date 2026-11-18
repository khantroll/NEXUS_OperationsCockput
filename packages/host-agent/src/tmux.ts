import { execFile } from "node:child_process";
import path from "node:path";
import type { SessionRecord } from "@nexus/contracts";

// Runs under Node's strip-only TypeScript mode in the desktop host: no parameter properties, enums,
// or relative ".js" value imports in this file.

export type TmuxStatus = "running" | "exited";

export interface TmuxSessionSnapshot {
  sessionId: string;
  pid: number;
  status: TmuxStatus;
  exitCode?: number;
}

export interface TmuxStartOptions {
  sessionId?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}

/** Runs `tmux <args>` and resolves with stdout. Must reject with a TmuxCommandError on failure. */
export type TmuxRunner = (args: readonly string[]) => Promise<string>;

export interface TmuxBackendOptions {
  /** Dedicated tmux server socket (`tmux -L`), isolating NEXUS from the user's own tmux. */
  socketName?: string;
  tmuxPath?: string;
  maxScrollbackLines?: number;
  maxReplayBytes?: number;
  run?: TmuxRunner;
}

export class TmuxCommandError extends Error {
  public readonly stderr: string;
  public readonly code: number | string | undefined;
  public constructor(message: string, stderr: string, code?: number | string) {
    super(message);
    this.name = "TmuxCommandError";
    this.stderr = stderr;
    this.code = code;
  }
}

const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const sessionPrefix = "nexus-";
const maxInputBytes = 64 * 1024;
const fieldSeparator = "|";
const listFormat = ["#{session_name}", "#{pane_pid}", "#{pane_dead}", "#{pane_dead_status}"].join(fieldSeparator);

/**
 * tmux-backed session owner for Linux (and any host with tmux >= 3.0). The tmux server, not this
 * process, owns the PTY, so sessions survive a restart of the supervisor/desktop; `list()` after a
 * restart finds them again. This class never uses a shell: every command is an argv array.
 */
export class TmuxBackend {
  private readonly socketName: string;
  private readonly tmuxPath: string;
  private readonly maxScrollbackLines: number;
  private readonly maxReplayBytes: number;
  private readonly runner: TmuxRunner;

  public constructor(options: TmuxBackendOptions = {}) {
    this.socketName = options.socketName ?? "nexus-cockpit";
    this.tmuxPath = options.tmuxPath ?? "tmux";
    this.maxScrollbackLines = options.maxScrollbackLines ?? 5_000;
    this.maxReplayBytes = options.maxReplayBytes ?? 64 * 1024;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(this.socketName)) throw new Error("invalid tmux socket name");
    if (!Number.isInteger(this.maxScrollbackLines) || this.maxScrollbackLines < 100 || this.maxScrollbackLines > 20_000) {
      throw new RangeError("maxScrollbackLines out of range");
    }
    if (!Number.isInteger(this.maxReplayBytes) || this.maxReplayBytes < 1) throw new RangeError("maxReplayBytes must be a positive integer");
    this.runner = options.run ?? ((args) => execTmux(this.tmuxPath, ["-L", this.socketName, ...args]));
  }

  /** Throws unless tmux >= 3.0 is runnable (the argv form of `new-session` needs it). */
  public async assertAvailable(): Promise<string> {
    const version = (await this.runner(["-V"])).trim();
    const match = version.match(/^tmux (?:next-)?(\d+)\.(\d+)/);
    if (!match || Number(match[1]) < 3) throw new Error(`tmux >= 3.0 required, found: ${version || "unknown"}`);
    return version;
  }

  public async start(file: string, args: readonly string[], options: TmuxStartOptions = {}): Promise<TmuxSessionSnapshot> {
    if (typeof file !== "string" || file.length === 0 || file.includes("\u0000")) throw new Error("invalid executable");
    if (args.some((arg) => typeof arg !== "string" || arg.includes("\u0000") || arg.length > 512) || args.length > 32) {
      throw new Error("invalid arguments");
    }
    const sessionId = options.sessionId ?? crypto.randomUUID();
    assertSessionId(sessionId);
    const cols = options.cols ?? 120;
    const rows = options.rows ?? 32;
    if (!Number.isInteger(cols) || cols < 20 || cols > 500 || !Number.isInteger(rows) || rows < 5 || rows > 200) {
      throw new RangeError("invalid terminal size");
    }
    if (options.cwd !== undefined && (!path.isAbsolute(options.cwd) || options.cwd.includes("\u0000"))) {
      throw new Error("cwd must be an absolute path");
    }
    // tmux splits argv into commands on any argument ending in ";" (even after "--"), which would let a
    // caller smuggle commands such as run-shell. Refuse such values rather than rely on escaping.
    for (const value of [file, ...args, ...(options.cwd === undefined ? [] : [options.cwd])]) {
      if (value.endsWith(";")) throw new Error("arguments must not end with ';'");
    }
    const name = sessionName(sessionId);
    // With exactly one command argument tmux runs it through "sh -c"; a leading "env --" keeps it argv-only.
    const command = args.length === 0 ? ["env", "--", file] : [file, ...args];
    try {
      // One invocation: server options are applied before the session exists, and re-applied if the
      // server was restarted, so remain-on-exit/exit-empty can never be silently lost.
      await this.runner([
        "start-server", ";",
        "set-option", "-g", "exit-empty", "off", ";",
        "set-option", "-g", "remain-on-exit", "on", ";",
        "set-option", "-g", "history-limit", String(this.maxScrollbackLines), ";",
        "new-session", "-d", "-s", name, "-x", String(cols), "-y", String(rows),
        ...(options.cwd === undefined ? [] : ["-c", options.cwd]),
        "--", ...command,
      ]);
    } catch (error) {
      if (error instanceof TmuxCommandError && /duplicate session/i.test(error.stderr)) throw new Error(`session already exists: ${sessionId}`);
      throw error;
    }
    return this.snapshot(sessionId);
  }

  /** All NEXUS-owned sessions on this socket; empty when no tmux server is running. */
  public async list(): Promise<TmuxSessionSnapshot[]> {
    let output: string;
    try {
      output = await this.runner(["list-sessions", "-F", listFormat]);
    } catch (error) {
      if (isNoServer(error)) return [];
      throw error;
    }
    return output.split("\n").flatMap((line) => {
      const parsed = parseListLine(line);
      return parsed ? [parsed] : [];
    });
  }

  public async snapshot(sessionId: string): Promise<TmuxSessionSnapshot> {
    assertSessionId(sessionId);
    const found = (await this.list()).find((session) => session.sessionId === sessionId);
    if (!found) throw new Error(`unknown session: ${sessionId}`);
    return found;
  }

  /** Visible pane plus scrollback as plain text, truncated to the most recent maxReplayBytes. */
  public async capture(sessionId: string): Promise<string> {
    assertSessionId(sessionId);
    const text = await this.targeted(sessionId, ["capture-pane", "-p", "-J", "-S", `-${this.maxScrollbackLines}`, "-t", paneTarget(sessionId)]);
    const buffer = Buffer.from(text, "utf8");
    return buffer.length <= this.maxReplayBytes ? text : buffer.subarray(buffer.length - this.maxReplayBytes).toString("utf8");
  }

  /** Sends literal text (no key-name interpretation). Authorization/leases belong to the caller. */
  public async sendInput(sessionId: string, data: string): Promise<void> {
    assertSessionId(sessionId);
    if (data.length === 0) return;
    if (data.includes("\u0000") || Buffer.byteLength(data, "utf8") > maxInputBytes) throw new Error("invalid input");
    // An argument ending in ";" is a tmux command separator, so trailing semicolons go as hex bytes.
    const body = data.replace(/;+$/, "");
    const trailing = data.length - body.length;
    if (body.length > 0) await this.targeted(sessionId, ["send-keys", "-t", paneTarget(sessionId), "-l", "--", body]);
    if (trailing > 0) await this.targeted(sessionId, ["send-keys", "-t", paneTarget(sessionId), "-H", ...Array<string>(trailing).fill("3b")]);
  }

  public async interrupt(sessionId: string): Promise<void> {
    assertSessionId(sessionId);
    await this.targeted(sessionId, ["send-keys", "-t", paneTarget(sessionId), "C-c"]);
  }

  /** Ends the session (and its process). Idempotent: an already-gone session is not an error. */
  public async kill(sessionId: string): Promise<void> {
    assertSessionId(sessionId);
    try {
      await this.runner(["kill-session", "-t", `=${sessionName(sessionId)}`]);
    } catch (error) {
      if (isNoServer(error) || isNoSession(error)) return;
      throw error;
    }
  }

  private async targeted(sessionId: string, args: readonly string[]): Promise<string> {
    try {
      return await this.runner(args);
    } catch (error) {
      if (isNoServer(error) || isNoSession(error)) throw new Error(`unknown session: ${sessionId}`);
      throw error;
    }
  }
}

/** Maps a tmux snapshot to a persisted record. Survivors found after a restart are `reconnectable`. */
export function toSessionRecord(snapshot: TmuxSessionSnapshot, hostId: string, hostBootEpoch: string, now: string, createdAt: string = now): SessionRecord {
  const running = snapshot.status === "running";
  return {
    sessionId: snapshot.sessionId,
    hostId,
    hostBootEpoch,
    kind: "local-pty",
    transport: running ? "connected" : "disconnected",
    process: running ? "running" : "exited",
    recovery: running ? "reconnectable" : "none",
    createdAt,
    lastObservedAt: now,
    pid: snapshot.pid,
    ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
  };
}

function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || !sessionIdPattern.test(sessionId)) throw new Error("invalid session ID");
}

function sessionName(sessionId: string): string {
  return `${sessionPrefix}${sessionId}`;
}

/** `=name:` is an exact-match pane target; plain `name` would prefix-match other sessions. */
function paneTarget(sessionId: string): string {
  return `=${sessionName(sessionId)}:`;
}

function parseListLine(line: string): TmuxSessionSnapshot | null {
  const [name, pid, dead, status] = line.split(fieldSeparator);
  if (name === undefined || !name.startsWith(sessionPrefix) || pid === undefined || dead === undefined) return null;
  const sessionId = name.slice(sessionPrefix.length);
  const pidNumber = Number(pid);
  if (!sessionIdPattern.test(sessionId) || !Number.isInteger(pidNumber)) return null;
  if (dead === "1") {
    const exitCode = status === undefined || status === "" ? undefined : Number(status);
    return { sessionId, pid: pidNumber, status: "exited", ...(exitCode === undefined || !Number.isInteger(exitCode) ? {} : { exitCode }) };
  }
  return { sessionId, pid: pidNumber, status: "running" };
}

function isNoServer(error: unknown): boolean {
  return error instanceof TmuxCommandError && /no server running|error connecting to .*\((no such file or directory|connection refused)\)|server exited unexpectedly/i.test(error.stderr);
}

function isNoSession(error: unknown): boolean {
  return error instanceof TmuxCommandError && /can't find (session|pane|window)|no current (session|target)/i.test(error.stderr);
}

function execTmux(tmuxPath: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(tmuxPath, [...args], { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        reject(new TmuxCommandError(`tmux ${args[0] ?? ""} failed`, String(stderr || error.message), code));
        return;
      }
      resolve(stdout);
    });
  });
}
