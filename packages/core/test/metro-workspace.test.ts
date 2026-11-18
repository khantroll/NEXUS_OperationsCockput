import assert from "node:assert/strict";
import test from "node:test";
import type { PanelRecord, WorkspaceRecord } from "../../contracts/src/index.js";
import {
  applyWorkspaceDrop,
  assertWorkspaceName,
  createWorkspaceRecord,
  movePanelToWorkspace,
  nextWorkspaceName,
} from "../src/metro-workspace.js";

const now = "2026-11-18T17:00:00.000Z";

function panel(workspaceId = "default"): PanelRecord {
  return {
    panelId: "p1",
    sessionId: "s1",
    workspaceId,
    placement: "parked",
    homeAnchor: {
      workspaceId,
      groupId: "terminals",
      splitPath: ["root"],
      tabIndex: 0,
      fallbackZone: "center",
      layoutRevision: 1,
    },
    revision: 3,
  };
}

test("assertWorkspaceName trims and rejects empty, oversized, or control-character names", () => {
  assert.equal(assertWorkspaceName("  Home Lab  "), "Home Lab");
  assert.equal(assertWorkspaceName("bad\nname"), "bad name");
  assert.throws(() => assertWorkspaceName("   "), /required/);
  assert.throws(() => assertWorkspaceName("x".repeat(81)), /too long/);
  assert.throws(() => assertWorkspaceName("bad\u0000name"), /control characters/);
});

test("nextWorkspaceName allocates the first unused Workspace label", () => {
  assert.equal(nextWorkspaceName([]), "Workspace");
  assert.equal(nextWorkspaceName([{ name: "Workspace" }]), "Workspace 2");
  assert.equal(nextWorkspaceName([{ name: "workspace" }, { name: "Workspace 2" }]), "Workspace 3");
});

test("createWorkspaceRecord persists a named workspace through the registry shape", () => {
  const workspace = createWorkspaceRecord({ name: "  Tank  ", now, workspaceId: "ws-tank" });
  assert.deepEqual(workspace, {
    workspaceId: "ws-tank",
    name: "Tank",
    createdAt: now,
    lastOpenedAt: now,
  });
  assert.throws(() => createWorkspaceRecord({ name: "Tank", now, workspaceId: "" }), /workspace id is required/);
});

test("movePanelToWorkspace updates the panel and home anchor and is idempotent", () => {
  const moved = movePanelToWorkspace(panel(), "lab");
  assert.equal(moved.workspaceId, "lab");
  assert.equal(moved.homeAnchor.workspaceId, "lab");
  assert.equal(moved.revision, 4);
  assert.equal(moved.sessionId, "s1");
  assert.equal(moved.placement, "parked");
  assert.equal(movePanelToWorkspace(moved, "lab"), moved);
});

test("applyWorkspaceDrop moves a panel onto an existing workspace or creates a new one", () => {
  const workspaces: WorkspaceRecord[] = [
    { workspaceId: "default", name: "Default", createdAt: now, lastOpenedAt: now },
    { workspaceId: "lab", name: "Home Lab", createdAt: now, lastOpenedAt: now },
  ];

  const existing = applyWorkspaceDrop(panel(), { kind: "existing", workspaceId: "lab" }, workspaces);
  assert.equal(existing.workspace, undefined);
  assert.equal(existing.panel.workspaceId, "lab");
  assert.equal(existing.panel.revision, 4);
  assert.equal(existing.workspaces.length, 2);

  const created = applyWorkspaceDrop(
    panel(),
    { kind: "new", name: "Conclave", workspaceId: "ws-conclave", now },
    workspaces,
  );
  assert.equal(created.workspace?.name, "Conclave");
  assert.equal(created.panel.workspaceId, "ws-conclave");
  assert.equal(created.workspaces.map((item) => item.workspaceId).join(","), "default,lab,ws-conclave");

  assert.throws(
    () => applyWorkspaceDrop(panel(), { kind: "existing", workspaceId: "missing" }, workspaces),
    /unknown workspace/,
  );
  assert.throws(
    () => applyWorkspaceDrop(panel(), { kind: "new", name: "Dup", workspaceId: "default", now }, workspaces),
    /already exists/,
  );
});
