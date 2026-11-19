import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";
import type { CliProfileRecord, PanelRecord, SessionRecord } from "../../contracts/src/index.js";
import type { WorkspaceRecord } from "@nexus/contracts";
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

const profile: CliProfileRecord = {
  profileId: "profile-claude",
  name: "Claude Code",
  executable: "claude",
  args: ["--version"],
  cwd: "C:\\AMD",
};

test("session and panel metadata survive store reopen", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nexus-storage-"));
  const filename = path.join(directory, "metadata.sqlite");
  try {
    const first = new MetadataStore(filename);
    first.saveSession(session);
    first.savePanel(panel);
    first.saveProfile(profile);
    first.close();

    const reopened = new MetadataStore(filename);
    assert.deepEqual(reopened.loadSession(session.sessionId), session);
    assert.deepEqual(reopened.loadPanel(panel.panelId), panel);
    assert.deepEqual(reopened.listPanels(panel.workspaceId), [panel]);
    assert.deepEqual(reopened.loadProfile(profile.profileId), profile);
    reopened.close();

    const schema = new DatabaseSync(filename);
    const sessionColumns = (schema.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>)
      .map(({ name }) => name).sort();
    const panelColumns = (schema.prepare("PRAGMA table_info(panels)").all() as Array<{ name: string }>)
      .map(({ name }) => name).sort();
    assert.deepEqual(sessionColumns, [
      "created_at", "cwd", "exit_code", "host_boot_epoch", "host_id", "kind", "label",
      "last_observed_at", "pid", "process", "recovery", "session_id", "transport",
    ]);
    assert.deepEqual(panelColumns, [
      "home_anchor", "panel_id", "placement", "revision", "session_id", "surface_id",
      "window_id", "workspace_id",
    ]);
    const profileColumns = (schema.prepare("PRAGMA table_info(profiles)").all() as Array<{ name: string }>)
      .map(({ name }) => name).sort();
    assert.deepEqual(profileColumns, ["args_json", "cwd", "executable", "name", "profile_id"]);
    assert.equal(profileColumns.some((name) => /credential|secret|token|password|env/i.test(name)), false);
    schema.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("session shelf listing is deterministic and includes recovery state", () => {
  const store = new MetadataStore(":memory:");
  store.saveSession(session);
  store.saveSession({ ...session, sessionId: "session-storage-0", process: "unknown", recovery: "relaunch-only" });
  assert.deepEqual(store.listSessions().map(({ sessionId, process, recovery }) => ({ sessionId, process, recovery })), [
    { sessionId: "session-storage-0", process: "unknown", recovery: "relaunch-only" },
    { sessionId: session.sessionId, process: "running", recovery: "reconnectable" },
  ]);
  store.close();
});

test("metadata rejects panels that reference unknown sessions", () => {
  const store = new MetadataStore(":memory:");
  assert.throws(() => store.savePanel(panel), /FOREIGN KEY constraint failed/);
  store.close();
});

test("profile metadata rejects credential-shaped arguments", () => {
  const store = new MetadataStore(":memory:");
  assert.throws(() => store.saveProfile({ ...profile, args: ["--api-key=not-for-persistence"] }), /credential-shaped/);
  assert.equal(store.listProfiles().length, 0);
  store.close();
});

test("supervisor restart reconciliation marks stale sessions for relaunch", () => {
  const store = new MetadataStore(":memory:");
  store.saveSession({ ...session, process: "running", hostBootEpoch: "old-boot" });
  store.saveSession({ ...session, sessionId: "session-exited", process: "exited", hostBootEpoch: "old-boot" });
  assert.equal(store.reconcileSupervisorRestart("new-boot"), 1);
  const reconciled = store.loadSession(session.sessionId);
  assert.ok(reconciled);
  assert.equal(reconciled.hostBootEpoch, "old-boot");
  assert.equal(reconciled.transport, "disconnected");
  assert.equal(reconciled.process, "unknown");
  assert.equal(reconciled.recovery, "relaunch-only");
  assert.notEqual(reconciled.lastObservedAt, session.lastObservedAt);
  assert.equal(store.loadSession("session-exited")?.process, "exited");
  store.close();
});

test("layout batch persistence is transactional", () => {
  const store = new MetadataStore(":memory:");
  store.saveSession(session);
  const invalidPanel = { ...panel, panelId: "panel-invalid", sessionId: "missing-session" };
  assert.throws(() => store.savePanels([panel, invalidPanel]), /FOREIGN KEY constraint failed/);
  assert.equal(store.loadPanel(panel.panelId), null);
  store.close();
});

test("workspace registry persists stable names and deterministic ordering", () => {
  const store = new MetadataStore(":memory:");
  const first: WorkspaceRecord = {
    workspaceId: "workspace-z",
    name: "Zeta",
    createdAt: "2026-11-15T00:00:00.000Z",
    lastOpenedAt: "2026-11-15T00:00:00.000Z",
  };
  const second: WorkspaceRecord = { ...first, workspaceId: "workspace-a", name: "Alpha" };
  const tie: WorkspaceRecord = { ...first, workspaceId: "workspace-b", name: "Alpha" };
  store.saveWorkspace(first);
  store.saveWorkspace(second);
  store.saveWorkspace(tie);
  assert.deepEqual(store.listWorkspaces(), [second, tie, first]);
  assert.deepEqual(store.loadWorkspace(first.workspaceId), first);
  assert.equal(store.deleteWorkspace(second.workspaceId), true);
  assert.equal(store.deleteWorkspace(second.workspaceId), false);
  store.saveSession(session);
  store.savePanel({ ...panel, workspaceId: first.workspaceId });
  assert.throws(() => store.deleteWorkspace(first.workspaceId), /workspace has panels/);
  store.close();
});

test("v1 metadata migrates to v4 without losing sessions or panels", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nexus-storage-migration-"));
  const filename = path.join(directory, "metadata.sqlite");
  try {
    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY, host_id TEXT NOT NULL, host_boot_epoch TEXT NOT NULL,
        kind TEXT NOT NULL, transport TEXT NOT NULL, process TEXT NOT NULL, recovery TEXT NOT NULL,
        created_at TEXT NOT NULL, last_observed_at TEXT NOT NULL, pid INTEGER, exit_code INTEGER
      );
      CREATE TABLE panels (
        panel_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        placement TEXT NOT NULL, home_anchor TEXT NOT NULL, revision INTEGER NOT NULL,
        surface_id TEXT, window_id TEXT
      );
      PRAGMA user_version = 1;
    `);
    legacy.close();
    const reopened = new MetadataStore(filename);
    reopened.saveSession(session);
    reopened.savePanel(panel);
    const migrated = new DatabaseSync(filename);
    const version = (migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    migrated.close();
    assert.equal(version, 4);
    assert.deepEqual(reopened.loadSession(session.sessionId), session);
    assert.deepEqual(reopened.loadPanel(panel.panelId), panel);
    assert.deepEqual(reopened.listWorkspaces(), []);
    assert.deepEqual(reopened.listProfiles(), []);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("session labels and cwd survive supervisor updates that omit them", () => {
  const store = new MetadataStore(":memory:");
  store.saveSession({ ...session, label: "Shell", cwd: "C:\\work" });
  const { pid: _pid, ...withoutPid } = session;
  store.saveSession({ ...withoutPid, process: "exited", recovery: "none", exitCode: 0 });
  const loaded = store.loadSession(session.sessionId);
  assert.equal(loaded?.label, "Shell");
  assert.equal(loaded?.cwd, "C:\\work");
  assert.equal(loaded?.process, "exited");
  assert.equal(loaded?.exitCode, 0);
  store.close();
});

test("deleteSessions removes sessions and cascaded panels", () => {
  const store = new MetadataStore(":memory:");
  store.saveSession(session);
  store.saveSession({ ...session, sessionId: "session-storage-2" });
  store.savePanel(panel);
  assert.equal(store.deleteSessions([session.sessionId]), 1);
  assert.equal(store.loadSession(session.sessionId), null);
  assert.equal(store.loadPanel(panel.panelId), null);
  assert.equal(store.loadSession("session-storage-2")?.sessionId, "session-storage-2");
  store.close();
});
