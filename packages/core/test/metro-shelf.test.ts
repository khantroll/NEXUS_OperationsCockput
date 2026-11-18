import assert from "node:assert/strict";
import test from "node:test";
import type { PanelRecord, WorkspaceRecord } from "../../contracts/src/index.js";
import { metroWorkspaceTiles, partitionMetroPanels } from "../src/metro-shelf.js";

const anchor = {
  workspaceId: "default",
  groupId: "terminals",
  splitPath: ["root"],
  tabIndex: 0,
  fallbackZone: "center" as const,
  layoutRevision: 1,
};

function panel(panelId: string, placement: PanelRecord["placement"], workspaceId = "default"): PanelRecord {
  return { panelId, sessionId: "s-" + panelId, workspaceId, placement, homeAnchor: { ...anchor, workspaceId }, revision: 1 };
}

test("partitionMetroPanels splits live workspace panels from the parked shelf", () => {
  const shelf = partitionMetroPanels([
    panel("a", "docked"),
    panel("b", "parked"),
    panel("c", "focused"),
    panel("d", "parked"),
    panel("e", "floating"),
  ]);
  assert.deepEqual(shelf.live.map((item) => item.panelId), ["a", "c", "e"]);
  assert.deepEqual(shelf.parked.map((item) => item.panelId), ["b", "d"]);
});

test("metroWorkspaceTiles mark the current workspace and count live vs parked panels", () => {
  const workspaces: WorkspaceRecord[] = [
    { workspaceId: "default", name: "Default", createdAt: "t0", lastOpenedAt: "t1" },
    { workspaceId: "lab", name: "Home Lab", createdAt: "t0", lastOpenedAt: "t1" },
  ];
  const panelsByWorkspace = new Map<string, PanelRecord[]>([
    ["default", [panel("a", "docked"), panel("b", "parked")]],
    ["lab", [panel("c", "focused", "lab")]],
  ]);
  const tiles = metroWorkspaceTiles(workspaces, "lab", panelsByWorkspace);
  assert.deepEqual(tiles, [
    { workspaceId: "default", name: "Default", current: false, liveCount: 1, parkedCount: 1 },
    { workspaceId: "lab", name: "Home Lab", current: true, liveCount: 1, parkedCount: 0 },
  ]);
});
