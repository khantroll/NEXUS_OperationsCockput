import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";
import type { PanelRecord, SessionRecord } from "../../contracts/src/index.js";
import { MetadataStore } from "../src/metadata.js";

const session: SessionRecord = {
  sessionId: "session-storage-1",
  hostId: "host-1",
  hostBootEpoch: "boot-1",
  kind: "local-pty",
  transport: "connected",
  process: "running",
  recovery: "reconnectable",
  createdAt: "2026-11-15T00:00:00.000Z",
  lastObservedAt: "2026-11-15T00:00:00.000Z",
  pid: 4242,
};

const panel: PanelRecord = {
  panelId: "panel-storage-1",
  sessionId: session.sessionId,
  workspaceId: "workspace-1",
  placement: "docked",
  homeAnchor: {
    workspaceId: "workspace-1",
    groupId: "terminals",
    splitPath: ["root", "center"],
    tabIndex: 0,
    fallbackZone: "center",
    layoutRevision: 3,
  },
  revision: 4,
};

test("session and panel metadata survive store reopen", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nexus-storage-"));
  const filename = path.join(directory, "metadata.sqlite");
  try {
    const first = new MetadataStore(filename);
    first.saveSession(session);
    first.savePanel(panel);
    first.close();

    const reopened = new MetadataStore(filename);
    assert.deepEqual(reopened.loadSession(session.sessionId), session);
    assert.deepEqual(reopened.loadPanel(panel.panelId), panel);
    assert.deepEqual(reopened.listPanels(panel.workspaceId), [panel]);
    reopened.close();

    const schema = new DatabaseSync(filename);
    const sessionColumns = (schema.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>)
      .map(({ name }) => name).sort();
    const panelColumns = (schema.prepare("PRAGMA table_info(panels)").all() as Array<{ name: string }>)
      .map(({ name }) => name).sort();
    assert.deepEqual(sessionColumns, [
      "created_at", "exit_code", "host_boot_epoch", "host_id", "kind", "last_observed_at",
      "pid", "process", "recovery", "session_id", "transport",
    ]);
    assert.deepEqual(panelColumns, [
      "home_anchor", "panel_id", "placement", "revision", "session_id", "surface_id",
      "window_id", "workspace_id",
    ]);
    schema.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("metadata rejects panels that reference unknown sessions", () => {
  const store = new MetadataStore(":memory:");
  assert.throws(() => store.savePanel(panel), /FOREIGN KEY constraint failed/);
  store.close();
});
