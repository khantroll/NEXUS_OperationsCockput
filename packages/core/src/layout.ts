import type { HomeAnchor, PanelRecord, PresentationState } from "../../contracts/src/index.js";

export interface LayoutRuntime {
  workspaceId: string;
  groupIds: readonly string[];
  displayIds: readonly string[];
  primaryDisplayId: string;
}

export interface ResolvedHomeAnchor {
  workspaceId: string;
  groupId: string;
  splitPath: readonly string[];
  tabIndex: number;
  fallbackZone: HomeAnchor["fallbackZone"];
  displayId: string;
  usedGroupFallback: boolean;
  usedDisplayFallback: boolean;
}

export interface RedactedPanelLayout {
  panelId: string;
  workspaceId: string;
  placement: PresentationState;
  homeAnchor: HomeAnchor;
  revision: number;
}

/** Export portable layout metadata without session IDs, window IDs, or surface IDs. */
export function exportRedactedLayout(panels: readonly PanelRecord[]): string {
  return JSON.stringify({
    version: 1,
    panels: panels.map(({ panelId, workspaceId, placement, homeAnchor, revision }) => ({
      panelId, workspaceId, placement, homeAnchor, revision,
    })),
  }, null, 2);
}

/** Parse imported layout metadata; session binding is deliberately left to the caller. */
export function importRedactedLayout(serialized: string): RedactedPanelLayout[] {
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw new Error("invalid layout export"); }
  if (typeof value !== "object" || value === null || !Array.isArray((value as { panels?: unknown }).panels)) {
    throw new Error("invalid layout export");
  }
  const panels = (value as { panels: unknown[] }).panels;
  const seen = new Set<string>();
  return panels.map((entry) => {
    if (typeof entry !== "object" || entry === null) throw new Error("invalid redacted panel");
    const panel = entry as Partial<RedactedPanelLayout>;
    if (typeof panel.panelId !== "string" || panel.panelId.length === 0 ||
      typeof panel.workspaceId !== "string" || panel.workspaceId.length === 0 ||
      !(["docked", "focused", "floating", "detached", "parked"] as string[]).includes(panel.placement ?? "") ||
      !Number.isInteger(panel.revision) ||
      typeof panel.homeAnchor !== "object" || panel.homeAnchor === null || seen.has(panel.panelId)) {
      throw new Error("invalid redacted panel");
    }
    seen.add(panel.panelId);
    return panel as RedactedPanelLayout;
  });
}

/** Resolve a persisted anchor deterministically without mutating layout state. */
export function resolveHomeAnchor(anchor: HomeAnchor, runtime: LayoutRuntime): ResolvedHomeAnchor {
  const groupExists = runtime.groupIds.includes(anchor.groupId);
  const displayExists = anchor.displayId !== undefined && runtime.displayIds.includes(anchor.displayId);
  const displayId = displayExists ? anchor.displayId! : runtime.primaryDisplayId;
  const groupId = groupExists ? anchor.groupId : `fallback:${anchor.fallbackZone}`;
  return {
    workspaceId: runtime.workspaceId,
    groupId,
    splitPath: anchor.splitPath,
    tabIndex: anchor.tabIndex,
    fallbackZone: anchor.fallbackZone,
    displayId,
    usedGroupFallback: !groupExists,
    usedDisplayFallback: !displayExists,
  };
}
