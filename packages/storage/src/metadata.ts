import { DatabaseSync } from "node:sqlite";
import { assertNonSecretCliArguments, type CliProfileRecord, type PanelRecord, type SessionRecord, type WorkspaceRecord } from "@nexus/contracts";

export interface StoredPanelSummary extends PanelRecord {}

/**
 * SQLite metadata boundary. Only known non-secret session/layout fields are
 * persisted; terminal output, credentials, cookies, and arbitrary URLs are not.
 */
export class MetadataStore {
  private readonly db: DatabaseSync;

  public constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.migrate();
  }

  public saveSession(session: SessionRecord): void {
    this.db.prepare(`
      INSERT INTO sessions (
        session_id, host_id, host_boot_epoch, kind, transport, process,
        recovery, created_at, last_observed_at, pid, exit_code, label, cwd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        host_id = excluded.host_id,
        host_boot_epoch = excluded.host_boot_epoch,
        kind = excluded.kind,
        transport = excluded.transport,
        process = excluded.process,
        recovery = excluded.recovery,
        last_observed_at = excluded.last_observed_at,
        pid = excluded.pid,
        exit_code = excluded.exit_code,
        label = COALESCE(excluded.label, sessions.label),
        cwd = COALESCE(excluded.cwd, sessions.cwd)
    `).run(
      session.sessionId,
      session.hostId,
      session.hostBootEpoch,
      session.kind,
      session.transport,
      session.process,
      session.recovery,
      session.createdAt,
      session.lastObservedAt,
      session.pid ?? null,
      session.exitCode ?? null,
      session.label ?? null,
      session.cwd ?? null,
    );
  }

  public loadSession(sessionId: string): SessionRecord | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as SessionRow | undefined;
    if (!row) return null;
    return {
      sessionId: row.session_id,
      hostId: row.host_id,
      hostBootEpoch: row.host_boot_epoch,
      kind: row.kind as SessionRecord["kind"],
      transport: row.transport as SessionRecord["transport"],
      process: row.process as SessionRecord["process"],
      recovery: row.recovery as SessionRecord["recovery"],
      createdAt: row.created_at,
      lastObservedAt: row.last_observed_at,
      ...(row.pid === null ? {} : { pid: row.pid }),
      ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
      ...(row.label === null || row.label === undefined ? {} : { label: row.label }),
      ...(row.cwd === null || row.cwd === undefined ? {} : { cwd: row.cwd }),
    };
  }

  public listSessions(): SessionRecord[] {
    const rows = this.db.prepare("SELECT session_id FROM sessions ORDER BY session_id").all() as Array<{ session_id: string }>;
    return rows.flatMap(({ session_id }) => {
      const session = this.loadSession(session_id);
      return session ? [session] : [];
    });
  }

  /** Delete a session and any panels that reference it (FK cascade). */
  public deleteSession(sessionId: string): boolean {
    return Number(this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId).changes) > 0;
  }

  public deleteSessions(sessionIds: readonly string[]): number {
    let removed = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const statement = this.db.prepare("DELETE FROM sessions WHERE session_id = ?");
      for (const sessionId of sessionIds) removed += Number(statement.run(sessionId).changes);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return removed;
  }

  public saveWorkspace(workspace: WorkspaceRecord): void {
    this.db.prepare(`
      INSERT INTO workspaces (workspace_id, name, created_at, last_opened_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        name = excluded.name,
        last_opened_at = excluded.last_opened_at
    `).run(workspace.workspaceId, workspace.name, workspace.createdAt, workspace.lastOpenedAt);
  }

  public loadWorkspace(workspaceId: string): WorkspaceRecord | null {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE workspace_id = ?").get(workspaceId) as WorkspaceRow | undefined;
    return row ? {
      workspaceId: row.workspace_id,
      name: row.name,
      createdAt: row.created_at,
      lastOpenedAt: row.last_opened_at,
    } : null;
  }

  public listWorkspaces(): WorkspaceRecord[] {
    const rows = this.db.prepare("SELECT * FROM workspaces ORDER BY name, workspace_id").all() as unknown as WorkspaceRow[];
    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      name: row.name,
      createdAt: row.created_at,
      lastOpenedAt: row.last_opened_at,
    }));
  }

  public saveProfile(profile: CliProfileRecord): void {
    assertNonSecretCliArguments(profile.args);
    this.db.prepare(`
      INSERT INTO profiles (profile_id, name, executable, args_json, cwd)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET
        name = excluded.name,
        executable = excluded.executable,
        args_json = excluded.args_json,
        cwd = excluded.cwd
    `).run(profile.profileId, profile.name, profile.executable, JSON.stringify(profile.args), profile.cwd ?? null);
  }

  public loadProfile(profileId: string): CliProfileRecord | null {
    const row = this.db.prepare("SELECT * FROM profiles WHERE profile_id = ?").get(profileId) as ProfileRow | undefined;
    if (!row) return null;
    return {
      profileId: row.profile_id,
      name: row.name,
      executable: row.executable as CliProfileRecord["executable"],
      args: JSON.parse(row.args_json) as string[],
      ...(row.cwd === null ? {} : { cwd: row.cwd }),
    };
  }

  public listProfiles(): CliProfileRecord[] {
    const rows = this.db.prepare("SELECT profile_id FROM profiles ORDER BY name, profile_id").all() as Array<{ profile_id: string }>;
    return rows.flatMap(({ profile_id }) => {
      const profile = this.loadProfile(profile_id);
      return profile ? [profile] : [];
    });
  }

  /** Delete an empty workspace; panels must be moved or removed explicitly first. */
  public deleteWorkspace(workspaceId: string): boolean {
    const panelCount = (this.db.prepare("SELECT COUNT(*) AS count FROM panels WHERE workspace_id = ?").get(workspaceId) as { count: number }).count;
    if (panelCount > 0) throw new Error("workspace has panels");
    return Number(this.db.prepare("DELETE FROM workspaces WHERE workspace_id = ?").run(workspaceId).changes) > 0;
  }

  /** Mark sessions owned by a prior supervisor epoch as requiring relaunch. */
  public reconcileSupervisorRestart(hostBootEpoch: string): number {
    const result = this.db.prepare(`
      UPDATE sessions
      SET transport = 'disconnected', process = 'unknown', recovery = 'relaunch-only',
          last_observed_at = ?
      WHERE host_boot_epoch <> ? AND process IN ('starting', 'running', 'unknown')
    `).run(new Date().toISOString(), hostBootEpoch);
    return Number(result.changes);
  }

  public savePanel(panel: PanelRecord): void {
    this.savePanelStatement().run(
      panel.panelId,
      panel.sessionId,
      panel.workspaceId,
      panel.placement,
      JSON.stringify(panel.homeAnchor),
      panel.revision,
      panel.surfaceId ?? null,
      panel.windowId ?? null,
    );
  }

  /** Atomically persist a layout snapshot, rolling back all panels on failure. */
  public savePanels(panels: readonly PanelRecord[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const statement = this.savePanelStatement();
      for (const panel of panels) {
        statement.run(
          panel.panelId,
          panel.sessionId,
          panel.workspaceId,
          panel.placement,
          JSON.stringify(panel.homeAnchor),
          panel.revision,
          panel.surfaceId ?? null,
          panel.windowId ?? null,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private savePanelStatement() {
    return this.db.prepare(`
      INSERT INTO panels (
        panel_id, session_id, workspace_id, placement, home_anchor,
        revision, surface_id, window_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(panel_id) DO UPDATE SET
        session_id = excluded.session_id,
        workspace_id = excluded.workspace_id,
        placement = excluded.placement,
        home_anchor = excluded.home_anchor,
        revision = excluded.revision,
        surface_id = excluded.surface_id,
        window_id = excluded.window_id
    `);
  }

  public loadPanel(panelId: string): PanelRecord | null {
    const row = this.db.prepare("SELECT * FROM panels WHERE panel_id = ?").get(panelId) as PanelRow | undefined;
    if (!row) return null;
    return {
      panelId: row.panel_id,
      sessionId: row.session_id,
      workspaceId: row.workspace_id,
      placement: row.placement as PanelRecord["placement"],
      homeAnchor: JSON.parse(row.home_anchor) as PanelRecord["homeAnchor"],
      revision: row.revision,
      ...(row.surface_id === null ? {} : { surfaceId: row.surface_id }),
      ...(row.window_id === null ? {} : { windowId: row.window_id }),
    };
  }

  public listPanels(workspaceId: string): StoredPanelSummary[] {
    const rows = this.db.prepare("SELECT panel_id FROM panels WHERE workspace_id = ? ORDER BY panel_id").all(workspaceId) as Array<{ panel_id: string }>;
    return rows.flatMap(({ panel_id }) => {
      const panel = this.loadPanel(panel_id);
      return panel ? [panel] : [];
    });
  }

  public deletePanel(panelId: string): boolean {
    return Number(this.db.prepare("DELETE FROM panels WHERE panel_id = ?").run(panelId).changes) > 0;
  }

  public close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec("PRAGMA foreign_keys = ON;");
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version < 1) this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        host_boot_epoch TEXT NOT NULL,
        kind TEXT NOT NULL,
        transport TEXT NOT NULL,
        process TEXT NOT NULL,
        recovery TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        pid INTEGER,
        exit_code INTEGER
      );
      CREATE TABLE IF NOT EXISTS panels (
        panel_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        placement TEXT NOT NULL,
        home_anchor TEXT NOT NULL,
        revision INTEGER NOT NULL,
        surface_id TEXT,
        window_id TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      PRAGMA user_version = 1;
    `);
    if (version < 2) this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL
      );
      PRAGMA user_version = 2;
    `);
    if (version < 3) this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        profile_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        executable TEXT NOT NULL,
        args_json TEXT NOT NULL,
        cwd TEXT
      );
      PRAGMA user_version = 3;
    `);
    if (version < 4) this.db.exec(`
      ALTER TABLE sessions ADD COLUMN label TEXT;
      ALTER TABLE sessions ADD COLUMN cwd TEXT;
      PRAGMA user_version = 4;
    `);
  }
}

interface SessionRow {
  session_id: string;
  host_id: string;
  host_boot_epoch: string;
  kind: string;
  transport: string;
  process: string;
  recovery: string;
  created_at: string;
  last_observed_at: string;
  pid: number | null;
  exit_code: number | null;
  label?: string | null;
  cwd?: string | null;
}

interface PanelRow {
  panel_id: string;
  session_id: string;
  workspace_id: string;
  placement: string;
  home_anchor: string;
  revision: number;
  surface_id: string | null;
  window_id: string | null;
}

interface WorkspaceRow {
  workspace_id: string;
  name: string;
  created_at: string;
  last_opened_at: string;
}

interface ProfileRow {
  profile_id: string;
  name: string;
  executable: string;
  args_json: string;
  cwd: string | null;
}
