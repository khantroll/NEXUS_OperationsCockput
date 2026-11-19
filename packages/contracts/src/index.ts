/**
 * NEXUS cross-runtime contract v0.1.
 * Types only: this package does NOT implement session durability.
 */
export type Id = string & { readonly __nexusId: unique symbol };
export type PresentationState = "docked" | "focused" | "floating" | "detached" | "parked";
export type TransportState = "connected" | "reconnecting" | "disconnected" | "unavailable";
export type ProcessState = "starting" | "running" | "exited" | "failed" | "unknown";
export type RecoveryState = "none" | "reconnectable" | "relaunch-only" | "needs-user-action";
export type SessionKind = "local-pty" | "ssh-pty" | "browser" | "vnc" | "rdp" | "external-link";

export interface HomeAnchor {
  workspaceId: string;
  groupId: string;
  splitPath: readonly string[];
  tabIndex: number;
  fallbackZone: "center" | "left" | "right" | "top" | "bottom";
  displayId?: string;
  layoutRevision: number;
}

export interface PanelRecord {
  panelId: string;
  sessionId: string;
  workspaceId: string;
  placement: PresentationState;
  homeAnchor: HomeAnchor;
  revision: number;
  /** Active presentation surface, absent while parked or docked in the home group. */
  surfaceId?: string;
  windowId?: string;
}

export interface WorkspaceRecord {
  workspaceId: string;
  name: string;
  createdAt: string;
  lastOpenedAt: string;
}

export type CliExecutable = "claude" | "codex" | "shell";

/** Non-secret launcher metadata. Environment variables and credentials are intentionally excluded. */
export interface CliProfileRecord {
  profileId: string;
  name: string;
  executable: CliExecutable;
  args: readonly string[];
  cwd?: string;
}

/** Persisted launcher arguments must remain configuration, never a secret transport. */
export function assertNonSecretCliArguments(args: readonly string[]): void {
  const secretShape = /(?:^|[-_])(?:token|password|secret|api[-_]?key|authorization|cookie|credential)(?:$|=|:)/i;
  if (args.some((arg) => secretShape.test(arg) || /^Bearer\s+/i.test(arg))) {
    throw new Error("profile arguments cannot contain credential-shaped values");
  }
}

export interface SessionRecord {
  sessionId: string;
  hostId: string;
  hostBootEpoch: string;
  kind: SessionKind;
  transport: TransportState;
  process: ProcessState;
  recovery: RecoveryState;
  createdAt: string;
  lastObservedAt: string;
  /** PID is advisory; session identity is not derived solely from the PID. */
  pid?: number;
  exitCode?: number | null;
  /** Operator-facing name, e.g. profile name. Never a secret. */
  label?: string;
  /** Working directory shown in the shelf, when known. Never a secret. */
  cwd?: string;
}

export interface AttachmentRecord {
  attachmentId: string;
  sessionId: string;
  clientId: string;
  mode: "read" | "write";
  createdAt: string;
}

export interface InputLease {
  sessionId: string;
  attachmentId: string;
  expiresAt: string;
  revision: number;
}

export interface CommandEnvelope<T> {
  requestId: string;
  actorId: string;
  expectedRevision: number;
  payload: T;
}

export type PanelCommand =
  | { op: "park"; panelId: string }
  | { op: "summon"; panelId: string; targetSurface: string }
  | { op: "snapBack"; panelId: string }
  | { op: "setHome"; panelId: string; anchor: HomeAnchor };

export type SessionCommand =
  | { op: "attach"; sessionId: string; clientId: string; mode: "read" | "write" }
  | { op: "detach"; attachmentId: string }
  | { op: "acquireInputLease"; sessionId: string; attachmentId: string }
  | { op: "terminate"; sessionId: string; confirmationToken: string };

/** A UI command does not imply backend execution or termination. */
export interface CommandResult {
  requestId: string;
  accepted: boolean;
  revision?: number;
  reason?: "stale-revision" | "unauthorized" | "unavailable" | "invalid-command";
}
