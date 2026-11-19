import type { ProcessState, RecoveryState } from "../../contracts/src/index.js";

export interface ShelfSession {
  sessionId: string;
  kind: string;
  process: ProcessState;
  recovery: RecoveryState;
  pid?: number;
  label?: string;
  cwd?: string;
}

export const DEMO_SESSION_ID = "desktop-demo-session";
export const DEMO_PANEL_ID = "demo-panel";
const SMOKE_SESSION_PREFIX = "desktop-profile-smoke-";

/** Sessions the default shelf hides: gone, failed, or only relaunchable. */
export function isHiddenShelfSession(session: ShelfSession): boolean {
  return session.process === "exited" || session.process === "unknown" || session.process === "failed"
    || session.recovery === "relaunch-only";
}

export function visibleShelfSessions(
  sessions: readonly ShelfSession[],
  showHidden: boolean,
): ShelfSession[] {
  return showHidden ? [...sessions] : sessions.filter((session) => !isHiddenShelfSession(session));
}

export function sessionDisplayName(session: ShelfSession): string {
  const label = session.label?.trim();
  const cwd = session.cwd?.trim();
  if (label && cwd) return label + " · " + cwd;
  if (label) return label;
  const shortId = session.sessionId.length > 8 ? session.sessionId.slice(0, 8) : session.sessionId;
  return (session.kind || "session") + " · " + shortId;
}

export function isLabOrDemoSession(session: Pick<ShelfSession, "sessionId">): boolean {
  return session.sessionId === DEMO_SESSION_ID
    || session.sessionId === "demo-session"
    || session.sessionId.startsWith(SMOKE_SESSION_PREFIX);
}

export function isLabOrDemoPanel(panelId: string): boolean {
  return panelId === DEMO_PANEL_ID;
}

/** Session IDs removed by "Clear exited" — the same set the default shelf hides. */
export function sessionsToClearExited(sessions: readonly ShelfSession[]): string[] {
  return sessions.filter((session) => isHiddenShelfSession(session) && !isLabOrDemoSession(session)).map((session) => session.sessionId);
}

export function sessionsToClearLab(sessions: readonly ShelfSession[]): string[] {
  return sessions.filter((session) => isLabOrDemoSession(session)).map((session) => session.sessionId);
}
