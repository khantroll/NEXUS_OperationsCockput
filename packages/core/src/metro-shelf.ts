import type { PanelRecord, WorkspaceRecord } from "../../contracts/src/index.js";

export interface MetroShelf {
  live: PanelRecord[];
  parked: PanelRecord[];
}

/**
 * Metro layout rule: live panels occupy the workspace grid; parked panels sit
 * in a separate shelf as individual items. SnapBack is a per-panel action on a
 * parked item, never a global "restore all". Double-click is the primary
 * restore gesture; a per-tile Restore control is the accessible secondary.
 */
export function partitionMetroPanels(panels: readonly PanelRecord[]): MetroShelf {
  const live: PanelRecord[] = [];
  const parked: PanelRecord[] = [];
  for (const panel of panels) {
    if (panel.placement === "parked") parked.push(panel);
    else live.push(panel);
  }
  return { live, parked };
}

export interface MetroWorkspaceTile {
  workspaceId: string;
  name: string;
  current: boolean;
  liveCount: number;
  parkedCount: number;
}

/** Build switcher tiles from the workspace registry and the panels in each one. */
export function metroWorkspaceTiles(
  workspaces: readonly WorkspaceRecord[],
  currentWorkspaceId: string,
  panelsByWorkspace: ReadonlyMap<string, readonly PanelRecord[]>,
): MetroWorkspaceTile[] {
  return workspaces.map((workspace) => {
    const shelf = partitionMetroPanels(panelsByWorkspace.get(workspace.workspaceId) ?? []);
    return {
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      current: workspace.workspaceId === currentWorkspaceId,
      liveCount: shelf.live.length,
      parkedCount: shelf.parked.length,
    };
  });
}
