import type { PanelRecord, WorkspaceRecord } from "../../contracts/src/index.js";

export const WORKSPACE_NAME_MAX_LENGTH = 80;

export function normalizeWorkspaceName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/** Trim, reject empty or oversized names, and strip control characters. */
export function assertWorkspaceName(name: string): string {
  const normalized = normalizeWorkspaceName(name);
  if (normalized.length === 0) throw new Error("workspace name is required");
  if (normalized.length > WORKSPACE_NAME_MAX_LENGTH) throw new Error("workspace name is too long");
  if (/[\u0000-\u001f]/.test(normalized)) throw new Error("workspace name contains control characters");
  return normalized;
}

/** First unused "Workspace" / "Workspace N" label. */
export function nextWorkspaceName(existing: readonly { name: string }[]): string {
  const used = new Set(existing.map((workspace) => workspace.name.toLowerCase()));
  if (!used.has("workspace")) return "Workspace";
  let index = 2;
  while (used.has("workspace " + index)) index += 1;
  return "Workspace " + index;
}

export function createWorkspaceRecord(input: {
  name: string;
  now: string;
  workspaceId: string;
}): WorkspaceRecord {
  if (input.workspaceId.length === 0) throw new Error("workspace id is required");
  const name = assertWorkspaceName(input.name);
  return {
    workspaceId: input.workspaceId,
    name,
    createdAt: input.now,
    lastOpenedAt: input.now,
  };
}

/**
 * Move a panel into another workspace. Presentation-only: the session is unchanged.
 * Idempotent when the panel is already in the target workspace.
 */
export function movePanelToWorkspace(panel: PanelRecord, workspaceId: string): PanelRecord {
  if (workspaceId.length === 0) throw new Error("workspace id is required");
  if (panel.workspaceId === workspaceId && panel.homeAnchor.workspaceId === workspaceId) return panel;
  return {
    ...panel,
    workspaceId,
    homeAnchor: { ...panel.homeAnchor, workspaceId },
    revision: panel.revision + 1,
  };
}

export type WorkspaceDropTarget =
  | { kind: "existing"; workspaceId: string }
  | { kind: "new"; name: string; workspaceId: string; now: string };

export interface WorkspaceDropResult {
  panel: PanelRecord;
  workspace?: WorkspaceRecord;
  workspaces: WorkspaceRecord[];
}

/** Apply a tile drop onto an existing workspace or a new-workspace target. */
export function applyWorkspaceDrop(
  panel: PanelRecord,
  target: WorkspaceDropTarget,
  workspaces: readonly WorkspaceRecord[],
): WorkspaceDropResult {
  if (target.kind === "existing") {
    const destination = workspaces.find((workspace) => workspace.workspaceId === target.workspaceId);
    if (!destination) throw new Error("unknown workspace");
    return { panel: movePanelToWorkspace(panel, destination.workspaceId), workspaces: [...workspaces] };
  }
  if (workspaces.some((workspace) => workspace.workspaceId === target.workspaceId)) {
    throw new Error("workspace already exists");
  }
  const workspace = createWorkspaceRecord({
    name: target.name,
    now: target.now,
    workspaceId: target.workspaceId,
  });
  return {
    panel: movePanelToWorkspace(panel, workspace.workspaceId),
    workspace,
    workspaces: [...workspaces, workspace],
  };
}
