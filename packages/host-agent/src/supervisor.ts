import * as pty from "node-pty";
import type { SessionRecord } from "../../contracts/src/index.js";

export type PtyStatus = "running" | "exited";
export type AttachmentMode = "read" | "write";

export interface PtySessionSnapshot {
  sessionId: string;
  pid: number;
  status: PtyStatus;
  exitCode?: number;
  outputBytes: number;
}

export interface PtyAttachment {
  readonly sessionId: string;
  readonly mode: AttachmentMode;
  readonly replay: string;
  onData(listener: (data: string) => void): () => void;
  write(data: string): void;
  detach(): void;
}

export interface PtyTerminationResult {
  session: PtySessionSnapshot;
  method: "already-exited" | "interrupt" | "forced-kill";
}

export interface PtyStartOptions {
  sessionId?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface SessionMetadataSink {
  saveSession(session: SessionRecord): void;
}

export interface PtySupervisorOptions {
  maxOutputBytes?: number;
  metadata?: SessionMetadataSink;
  hostId?: string;
  hostBootEpoch?: string;
}

interface ManagedSession {
  readonly id: string;
  readonly pty: pty.IPty;
  readonly createdAt: string;
  readonly chunks: string[];
  readonly maxOutputBytes: number;
  outputBytes: number;
  status: PtyStatus;
  exitCode?: number;
  listeners: Set<(data: string) => void>;
  attachmentCount: number;
  disposed: boolean;
  terminationTimer?: NodeJS.Timeout;
}

/**
 * Renderer-independent PTY owner for the Windows host-agent spike.
 *
 * This class owns node-pty processes and bounded replay only. It deliberately
 * has no Electron dependency and does not claim survival of this supervisor
 * process itself.
 */
export class PtySupervisor {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly maxOutputBytes: number;
  private readonly metadata: SessionMetadataSink | undefined;
  private readonly hostId: string;
  private readonly hostBootEpoch: string;

  public constructor(maxOutputBytesOrOptions: number | PtySupervisorOptions = 64 * 1024, metadata?: SessionMetadataSink) {
    const options: PtySupervisorOptions = typeof maxOutputBytesOrOptions === "number"
      ? { maxOutputBytes: maxOutputBytesOrOptions, ...(metadata === undefined ? {} : { metadata }) }
      : maxOutputBytesOrOptions;
    this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
    this.metadata = options.metadata;
    this.hostId = options.hostId ?? "windows-xenos";
    this.hostBootEpoch = options.hostBootEpoch ?? `supervisor-${process.pid}`;
    if (!Number.isInteger(this.maxOutputBytes) || this.maxOutputBytes < 1) {
      throw new RangeError("maxOutputBytes must be a positive integer");
    }
  }

  public start(file: string, args: string[], options: PtyStartOptions = {}): PtySessionSnapshot {
    const sessionId = options.sessionId ?? crypto.randomUUID();
    if (this.sessions.has(sessionId)) throw new Error(`session already exists: ${sessionId}`);
    const child = pty.spawn(file, args, {
      name: "xterm-256color",
      cols: options.cols ?? 120,
      rows: options.rows ?? 32,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      useConpty: true,
    });
    const managed: ManagedSession = {
      id: sessionId,
      pty: child,
      createdAt: new Date().toISOString(),
      chunks: [],
      maxOutputBytes: this.maxOutputBytes,
      outputBytes: 0,
      status: "running",
      listeners: new Set(),
      attachmentCount: 0,
      disposed: false,
    };
    child.onData((data) => {
      managed.chunks.push(data);
      managed.outputBytes += Buffer.byteLength(data);
      while (managed.outputBytes > managed.maxOutputBytes && managed.chunks.length > 0) {
        const removed = managed.chunks.shift()!;
        managed.outputBytes -= Buffer.byteLength(removed);
      }
      for (const listener of managed.listeners) listener(data);
    });
    child.onExit(({ exitCode }) => {
      if (managed.terminationTimer) clearTimeout(managed.terminationTimer);
      managed.status = "exited";
      managed.exitCode = exitCode;
      this.persist(managed, "disconnected", "exited", "none");
    });
    this.sessions.set(sessionId, managed);
    this.persist(managed, "connected", "running", "none");
    return this.snapshotManaged(managed);
  }

  public attach(sessionId: string, mode: AttachmentMode): PtyAttachment {
    const managed = this.sessions.get(sessionId);
    if (!managed) throw new Error(`unknown session: ${sessionId}`);
    if (managed.disposed) throw new Error("session has been disposed");
    managed.attachmentCount += 1;
    let attached = true;
    const listeners = new Set<(data: string) => void>();
    const detach = (): void => {
      if (!attached) return;
      attached = false;
      managed.attachmentCount -= 1;
      for (const listener of listeners) managed.listeners.delete(listener);
      listeners.clear();
    };
    return {
      sessionId,
      mode,
      replay: managed.chunks.join(""),
      onData: (listener) => {
        if (!attached || managed.disposed) throw new Error("attachment is detached");
        listeners.add(listener);
        managed.listeners.add(listener);
        return () => {
          listeners.delete(listener);
          managed.listeners.delete(listener);
        };
      },
      write: (data) => {
        if (!attached || managed.disposed) throw new Error("attachment is detached");
        if (mode !== "write") throw new Error("read attachment cannot write");
        managed.pty.write(data);
      },
      detach,
    };
  }

  public snapshot(sessionId: string): PtySessionSnapshot {
    const managed = this.sessions.get(sessionId);
    if (!managed) throw new Error(`unknown session: ${sessionId}`);
    return this.snapshotManaged(managed);
  }

  public async terminate(sessionId: string): Promise<PtyTerminationResult> {
    const managed = this.sessions.get(sessionId);
    if (!managed) throw new Error(`unknown session: ${sessionId}`);
    if (managed.status === "exited") {
      return { session: this.snapshotManaged(managed), method: "already-exited" };
    }
    managed.pty.write("\u0003");
    if (await this.waitForExit(sessionId, 500)) {
      return { session: this.snapshotManaged(managed), method: "interrupt" };
    }
    managed.pty.kill();
    if (!(await this.waitForExit(sessionId, 1000))) {
      throw new Error(`session did not exit after forced termination: ${sessionId}`);
    }
    return { session: this.snapshotManaged(managed), method: "forced-kill" };
  }

  public async waitForExit(sessionId: string, timeoutMs = 3000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.snapshot(sessionId).status === "exited") return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.snapshot(sessionId).status === "exited";
  }

  /** Release a completed session's PTY and replay memory after callers finish recovery. */
  public dispose(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) throw new Error(`unknown session: ${sessionId}`);
    if (managed.status !== "exited") throw new Error("cannot dispose a running session");
    if (managed.attachmentCount > 0) throw new Error("cannot dispose an attached session");
    managed.disposed = true;
    // node-pty does not expose a separate close method; kill releases the
    // native ConPTY handle even when the child already exited.
    try {
      managed.pty.kill();
    } catch {
      // The process is already exited; registry disposal remains safe.
    }
    this.sessions.delete(sessionId);
  }

  private snapshotManaged(managed: ManagedSession): PtySessionSnapshot {
    return {
      sessionId: managed.id,
      pid: managed.pty.pid,
      status: managed.status,
      ...(managed.exitCode === undefined ? {} : { exitCode: managed.exitCode }),
      outputBytes: managed.outputBytes,
    };
  }

  private persist(
    managed: ManagedSession,
    transport: SessionRecord["transport"],
    processState: SessionRecord["process"],
    recovery: SessionRecord["recovery"],
  ): void {
    if (this.metadata === undefined) return;
    const observedAt = new Date().toISOString();
    try {
      this.metadata.saveSession({
        sessionId: managed.id,
        hostId: this.hostId,
        hostBootEpoch: this.hostBootEpoch,
        kind: "local-pty",
        transport,
        process: processState,
        recovery,
        createdAt: managed.createdAt,
        lastObservedAt: observedAt,
        pid: managed.pty.pid,
        ...(managed.exitCode === undefined ? {} : { exitCode: managed.exitCode }),
      });
    } catch {
      // Metadata is optional; a sink failure must not orphan or terminate the PTY.
    }
  }
}
