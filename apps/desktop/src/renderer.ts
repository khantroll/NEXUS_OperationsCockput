import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CommandEnvelope, PanelCommand, PanelRecord, WorkspaceRecord } from "../../../packages/contracts/src/index.js";
import { applyPanelCommand } from "../../../packages/core/src/lifecycle.js";
import { metroWorkspaceTiles, partitionMetroPanels } from "../../../packages/core/src/metro-shelf.js";
import { TerminalView, discardTerminalBuffer, routeTerminalData } from "./terminal-view.js";

declare global {
  interface Window {
    nexusShell: { version: string; capabilities: string[] };
    nexusHost: {
      startDemoSession: () => Promise<{ sessionId: string; pid: number; status: string; outputBytes: number }>;
      startProfile: (profile: { profileId: string; name: string; executable: "claude" | "codex" | "shell"; args: string[]; cwd?: string }, sessionId?: string) => Promise<{ sessionId: string; pid: number; status: string; outputBytes: number }>;
      status: (sessionId: string) => Promise<{ sessionId: string; pid: number; status: string; outputBytes: number }>;
      attach: (sessionId: string, mode?: "read" | "write") => Promise<{ attachmentId: string; replay: string }>;
      detach: (attachmentId: string) => Promise<void>;
      write: (attachmentId: string, data: string) => Promise<void>;
      resize: (attachmentId: string, cols: number, rows: number) => Promise<void>;
      interrupt: (sessionId: string) => Promise<unknown>;
      restartProfile: (sessionId: string, profile: unknown) => Promise<unknown>;
      terminate: (sessionId: string, confirmationToken: string) => Promise<unknown>;
      onData: (listener: (payload: { attachmentId: string; data: string }) => void) => () => void;
    };
    nexusLayout: { save: (panels: PanelRecord[]) => Promise<void>; load: (panelId: string) => Promise<PanelRecord | null>; list: (workspaceId: string) => Promise<PanelRecord[]>; export: (workspaceId: string) => Promise<string>; import: (serialized: string) => Promise<unknown> };
    nexusWorkspace: { list: () => Promise<WorkspaceRecord[]>; save: (workspace: WorkspaceRecord) => Promise<void> };
    nexusSsh: {
      list: () => Promise<{ path: string; errors: string[]; profiles: Array<{ profileId: string; name: string; host: string; user?: string; port?: number; remoteTmuxSession?: string }> }>;
      start: (profileId: string) => Promise<{ sessionId: string; pid: number; status: string; outputBytes: number; name: string }>;
      openFile: () => Promise<string | null>;
    };
    nexusCompanion: { openNetworkFile: () => Promise<string | null>; info: () => Promise<{ mode: "local" | "private" | "https"; networkWarning: string | null; url: string; hostId: string; credentialsPath: string | null; credentialsWarning: string | null; enrollmentToken?: string } | null> };
    nexusSessions: { list: () => Promise<Array<{ sessionId: string; kind: string; transport: string; process: string; recovery: string; pid?: number }>> };
  }
}

const initialPanel: PanelRecord = {
  panelId: "demo-panel",
  sessionId: "demo-session",
  workspaceId: "default",
  placement: "docked",
  homeAnchor: {
    workspaceId: "default",
    groupId: "terminals",
    splitPath: ["root", "center"],
    tabIndex: 0,
    fallbackZone: "center",
    layoutRevision: 1,
  },
  revision: 1,
};

function command(panel: PanelRecord, payload: PanelCommand): CommandEnvelope<PanelCommand> {
  return {
    requestId: crypto.randomUUID(),
    actorId: "desktop-operator",
    expectedRevision: panel.revision,
    payload,
  };
}

function App(): React.JSX.Element {
  const [panel, setPanel] = useState(initialPanel);
  type ProfilePanel = { panel: PanelRecord; attachmentId: string; output: string; writable: boolean; label: string; profile?: { profileId: string; name: string; executable: "claude" | "codex" | "shell"; args: string[] } };
  const [profilePanels, setProfilePanels] = useState<ProfilePanel[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceRecord>({
    workspaceId: "default",
    name: "Default",
    createdAt: "2026-11-15T00:00:00.000Z",
    lastOpenedAt: "2026-11-15T00:00:00.000Z",
  });
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [panelsByWorkspace, setPanelsByWorkspace] = useState<ReadonlyMap<string, PanelRecord[]>>(new Map());
  const [companionInfo, setCompanionInfo] = useState<Awaited<ReturnType<Window["nexusCompanion"]["info"]>>>(null);
  const [companionDismissed, setCompanionDismissed] = useState(false);
  const [sshInfo, setSshInfo] = useState<Awaited<ReturnType<Window["nexusSsh"]["list"]>> | null>(null);
  const [sshError, setSshError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Array<{ sessionId: string; kind: string; transport: string; process: string; recovery: string; pid?: number }>>([]);
  const [lifecycleErrors, setLifecycleErrors] = useState<Record<string, string>>({});
  const [hostSession, setHostSession] = useState<{ sessionId: string; pid: number; status: string; outputBytes: number } | null>(null);
  const [hostOutput, setHostOutput] = useState("");
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const [layoutLoaded, setLayoutLoaded] = useState(false);
  const persistPanel = (nextPanel: PanelRecord): void => {
    if (nextPanel.sessionId !== "demo-session") void window.nexusLayout.save([nextPanel]).catch(() => undefined);
  };
  const dispatch = (payload: PanelCommand): void => {
    const transition = applyPanelCommand(panel, command(panel, payload));
    if (transition.result.accepted) {
      setPanel(transition.record);
      persistPanel(transition.record);
    }
  };
  const connectHost = async (): Promise<void> => {
    if (attachmentId) await window.nexusHost.detach(attachmentId);
    const session = await window.nexusHost.startDemoSession();
    const attached = await window.nexusHost.attach(session.sessionId);
    setHostSession(session);
    setSessions((current) => current.some((candidate) => candidate.sessionId === session.sessionId)
      ? current.map((candidate) => candidate.sessionId === session.sessionId ? { ...candidate, process: session.status, pid: session.pid } : candidate)
      : [...current, { sessionId: session.sessionId, kind: "local-pty", transport: "connected", process: session.status, recovery: "none", pid: session.pid }]);
    const nextPanel = { ...panel, sessionId: session.sessionId };
    setPanel(nextPanel);
    persistPanel(nextPanel);
    setAttachmentId(attached.attachmentId);
    setHostOutput(attached.replay);
  };
  const disconnectHost = async (): Promise<void> => {
    if (attachmentId) await window.nexusHost.detach(attachmentId);
    setAttachmentId(null);
  };
  /** Prefer an input-capable attachment; fall back to read-only if another view already holds the writer. */
  const attachInteractive = async (sessionId: string): Promise<{ attachmentId: string; replay: string; writable: boolean }> => {
    try {
      return { ...(await window.nexusHost.attach(sessionId, "write")), writable: true };
    } catch {
      return { ...(await window.nexusHost.attach(sessionId, "read")), writable: false };
    }
  };
  const launchProfile = async (profile: { profileId: string; name: string; executable: "claude" | "codex" | "shell"; args: string[] }): Promise<void> => {
    await presentSession(await window.nexusHost.startProfile(profile), profile.name, profile);
  };
  const refreshSsh = (): void => {
    void window.nexusSsh.list().then((info) => { setSshInfo(info); setSshError(null); }).catch(() => setSshError("could not load SSH profiles"));
  };
  const connectSsh = async (profileId: string): Promise<void> => {
    try {
      const session = await window.nexusSsh.start(profileId);
      await presentSession(session, session.name);
      setSshError(null);
    } catch (error) {
      setSshError(error instanceof Error ? error.message : String(error));
    }
  };
  const presentSession = async (session: { sessionId: string; pid: number; status: string }, label: string, profile?: { profileId: string; name: string; executable: "claude" | "codex" | "shell"; args: string[] }): Promise<void> => {
    const attached = await attachInteractive(session.sessionId);
    const profilePanel: PanelRecord = {
      panelId: "profile-panel-"+session.sessionId,
      sessionId: session.sessionId,
      workspaceId: workspace.workspaceId,
      placement: "docked",
      homeAnchor: { ...initialPanel.homeAnchor, workspaceId: workspace.workspaceId, groupId: "profiles", tabIndex: profilePanels.length, layoutRevision: 1 },
      revision: 1,
    };
    setProfilePanels((current) => [...current, { panel: profilePanel, attachmentId: attached.attachmentId, output: attached.replay, writable: attached.writable, label, ...(profile === undefined ? {} : { profile }) }]);
    void window.nexusLayout.save([profilePanel]).catch(() => undefined);
    setSessions((current) => [...current.filter((candidate) => candidate.sessionId !== session.sessionId), {
      sessionId: session.sessionId, kind: "local-pty", transport: "connected", process: session.status, recovery: "none", pid: session.pid,
    }]);
  };
  const runProfileLifecycle = async (entry: ProfilePanel, operation: "interrupt" | "restart" | "terminate"): Promise<void> => {
    try {
      if (operation === "interrupt") {
        const result = await window.nexusHost.interrupt(entry.panel.sessionId) as { status: string };
        setSessions((current) => current.map((candidate) => candidate.sessionId === entry.panel.sessionId ? { ...candidate, process: result.status } : candidate));
        return;
      }
      if (operation === "restart" && entry.profile) {
        await window.nexusHost.detach(entry.attachmentId);
        await window.nexusHost.restartProfile(entry.panel.sessionId, entry.profile);
        const attached = await attachInteractive(entry.panel.sessionId);
        setProfilePanels((current) => current.map((candidate) => candidate.panel.panelId === entry.panel.panelId
          ? { ...candidate, attachmentId: attached.attachmentId, output: attached.replay, writable: attached.writable } : candidate));
        setSessions((current) => current.map((candidate) => candidate.sessionId === entry.panel.sessionId ? { ...candidate, process: "running", transport: "connected", recovery: "none" } : candidate));
        setLifecycleErrors((current) => { const next = { ...current }; delete next[entry.panel.panelId]; return next; });
        return;
      }
      if (operation === "terminate") {
        await window.nexusHost.terminate(entry.panel.sessionId, `terminate:${entry.panel.sessionId}`);
        setProfilePanels((current) => current.filter((candidate) => candidate.panel.panelId !== entry.panel.panelId));
        setSessions((current) => current.map((candidate) => candidate.sessionId === entry.panel.sessionId ? { ...candidate, process: "exited", transport: "disconnected" } : candidate));
      }
    } catch (error) {
      setLifecycleErrors((current) => ({ ...current, [entry.panel.panelId]: error instanceof Error ? error.message : String(error) }));
      try {
        // Best effort: if the old attachment is still live it would otherwise keep the writer lock.
        await window.nexusHost.detach(entry.attachmentId).catch(() => undefined);
        discardTerminalBuffer(entry.attachmentId);
        const attached = await attachInteractive(entry.panel.sessionId);
        setProfilePanels((current) => current.map((candidate) => candidate.panel.panelId === entry.panel.panelId
          ? { ...candidate, attachmentId: attached.attachmentId, output: attached.replay, writable: attached.writable } : candidate));
      } catch { /* preserve the visible failure and session shelf state */ }
    }
  };
  /** Close = stop the session if it is still running, release the view, and remove the panel (works for exited panels too). */
  const closeProfilePanel = async (entry: ProfilePanel): Promise<void> => {
    await window.nexusHost.detach(entry.attachmentId).catch(() => undefined);
    discardTerminalBuffer(entry.attachmentId);
    await window.nexusHost.terminate(entry.panel.sessionId, `close:${entry.panel.sessionId}`).catch(() => undefined);
    setProfilePanels((current) => current.filter((candidate) => candidate.panel.panelId !== entry.panel.panelId));
    setSessions((current) => current.map((candidate) => candidate.sessionId === entry.panel.sessionId ? { ...candidate, process: "exited", transport: "disconnected" } : candidate));
  };
  const dispatchProfile = (panelId: string, payload: PanelCommand): void => {
    setProfilePanels((current) => current.map((entry) => {
      if (entry.panel.panelId !== panelId) return entry;
      const transition = applyPanelCommand(entry.panel, command(entry.panel, payload));
      if (!transition.result.accepted) return entry;
      void window.nexusLayout.save([transition.record]).catch(() => undefined);
      return { ...entry, panel: transition.record };
    }));
  };
  useEffect(() => {
    refreshSsh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void window.nexusCompanion.info().then(setCompanionInfo).catch(() => setCompanionInfo(null));
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || !event.shiftKey || event.altKey) return;
      if (event.key === "p") { event.preventDefault(); dispatch({ op: "park", panelId: panel.panelId }); }
      if (event.key === "s") { event.preventDefault(); dispatch({ op: "summon", panelId: panel.panelId, targetSurface: "main" }); }
      if (event.key === "b") { event.preventDefault(); dispatch({ op: "snapBack", panelId: panel.panelId }); }
      if (event.key === "h") {
        event.preventDefault();
        dispatch({ op: "setHome", panelId: panel.panelId, anchor: { ...panel.homeAnchor, layoutRevision: panel.homeAnchor.layoutRevision + 1 } });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [panel]);
  useEffect(() => {
    void Promise.all([
      window.nexusLayout.load("demo-panel"),
      window.nexusLayout.list("default"),
      window.nexusWorkspace.list(),
      window.nexusSessions.list(),
    ])
      .then(([saved, savedPanels, workspaces, persistedSessions]) => {
        if (saved) setPanel(saved);
        setSessions(persistedSessions);
        void Promise.all(savedPanels.filter((candidate) => candidate.panelId !== "demo-panel").map(async (savedPanel) => {
          try {
            const attached = await attachInteractive(savedPanel.sessionId);
            const recovered: ProfilePanel = { panel: savedPanel, attachmentId: attached.attachmentId, output: attached.replay, writable: attached.writable, label: "Recovered terminal" };
            setProfilePanels((current) => [...current, recovered]);
          } catch { /* session is gone; leave the saved panel out */ }
        }));
        setWorkspaces(workspaces);
        const current = workspaces.find((candidate) => candidate.workspaceId === "default");
        if (current) setWorkspace({ ...current, lastOpenedAt: new Date().toISOString() });
        else {
          const created = { ...workspace, lastOpenedAt: new Date().toISOString() };
          setWorkspace(created);
          setWorkspaces((existing) => existing.some((item) => item.workspaceId === created.workspaceId) ? existing : [...existing, created]);
          void window.nexusWorkspace.save(created);
        }
        const listed = new Map<string, PanelRecord[]>();
        listed.set("default", savedPanels);
        setPanelsByWorkspace(listed);
        void Promise.all(workspaces.filter((item) => item.workspaceId !== "default").map(async (item) => {
          const panels = await window.nexusLayout.list(item.workspaceId);
          setPanelsByWorkspace((currentMap) => new Map(currentMap).set(item.workspaceId, panels));
        }));
        setLayoutLoaded(true);
      })
      .catch(() => setLayoutLoaded(true));
  }, []);
  useEffect(() => window.nexusHost.onData(routeTerminalData), []);
  useEffect(() => {
    const unsubscribe = window.nexusHost.onData((payload) => {
      if (payload.attachmentId === attachmentId) setHostOutput((current) => (current + payload.data).slice(-4000));
    });
    if (layoutLoaded && attachmentId === null) void connectHost();
    return unsubscribe;
  // The bridge owns cleanup when the renderer is reloaded; this subscription only
  // needs to follow the current attachment ID for the lifetime of this renderer.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentId, layoutLoaded]);

  useEffect(() => {
    const currentPanels = [panel, ...profilePanels.map((entry) => entry.panel)].filter((item) => item.workspaceId === workspace.workspaceId);
    setPanelsByWorkspace((current) => new Map(current).set(workspace.workspaceId, currentPanels));
  }, [panel, profilePanels, workspace.workspaceId]);

  const visibleProfiles = profilePanels.filter((entry) => entry.panel.workspaceId === workspace.workspaceId);
  const shelf = partitionMetroPanels([
    ...(panel.workspaceId === workspace.workspaceId ? [panel] : []),
    ...visibleProfiles.map((entry) => entry.panel),
  ]);
  const tiles = metroWorkspaceTiles(workspaces, workspace.workspaceId, panelsByWorkspace);
  const tileColors = ["#0072C6", "#00A4A6", "#A7008F", "#DC572E", "#8CBD18", "#F0A30A"];

  function snapBackPanel(target: PanelRecord): void {
    if (target.panelId === panel.panelId) dispatch({ op: "snapBack", panelId: target.panelId });
    else dispatchProfile(target.panelId, { op: "snapBack", panelId: target.panelId });
  }

  function parkPanel(target: PanelRecord): void {
    if (target.panelId === panel.panelId) dispatch({ op: "park", panelId: target.panelId });
    else dispatchProfile(target.panelId, { op: "park", panelId: target.panelId });
  }

  function renderPanelChrome(target: PanelRecord, title: string, extra?: React.ReactNode): React.JSX.Element {
    const parked = target.placement === "parked";
    return React.createElement("article", {
      key: target.panelId,
      style: parked ? styles.parkedTile : styles.liveTile,
      "data-panel-id": target.panelId,
      "data-panel-placement": target.placement,
      "data-panel-revision": target.revision,
      onDoubleClick: parked ? () => snapBackPanel(target) : undefined,
    },
      React.createElement("div", { style: styles.tileHeader },
        React.createElement("div", null,
          React.createElement("strong", null, title),
          React.createElement("div", { style: styles.tileState }, (parked ? "Parked · session still live" : "Running") + " · " + target.placement),
        ),
        React.createElement("span", { style: styles.revision }, "rev " + target.revision),
      ),
      extra ?? null,
    );
  }

  return React.createElement(
    "main",
    { style: styles.app },
    React.createElement(
      "header",
      { style: styles.header },
      React.createElement("div", null,
        React.createElement("div", { style: styles.eyebrow }, "NEXUS OPERATIONS COCKPIT"),
        React.createElement("h1", { style: styles.title }, workspace.name),
      ),
      React.createElement("span", { style: styles.badge }, window.nexusShell.version),
    ),
    React.createElement("nav", { style: styles.switcher, "aria-label": "Workspaces" },
      tiles.length === 0
        ? React.createElement("div", { style: styles.workspaceTile, "data-current": "true" }, workspace.name)
        : tiles.map((tile, index) => React.createElement("button", {
          key: tile.workspaceId,
          type: "button",
          style: { ...styles.workspaceTile, background: tileColors[index % tileColors.length], outline: tile.current ? "3px solid #fff" : "none" },
          "data-current": tile.current ? "true" : "false",
          onClick: () => {
            const record = workspaces.find((item) => item.workspaceId === tile.workspaceId);
            if (record) setWorkspace({ ...record, lastOpenedAt: new Date().toISOString() });
          },
        },
          React.createElement("span", { style: styles.workspaceTileName }, tile.name),
          React.createElement("span", { style: styles.workspaceTileMeta }, tile.liveCount + " live · " + tile.parkedCount + " parked"),
        )),
    ),
    React.createElement(
      "section",
      { style: styles.workspace },
      React.createElement("section", { style: styles.canvas },
        React.createElement("div", { style: styles.sectionLabel }, "LIVE WORKSPACE"),
        React.createElement("div", { style: styles.liveGrid },
          shelf.live.length === 0
            ? React.createElement("div", { style: styles.muted }, "No live panels in this workspace. Restore one from Parked, or launch a session.")
            : null,
          shelf.live.map((item) => {
            if (item.panelId === panel.panelId) {
              return renderPanelChrome(panel, "Terminal presentation",
                React.createElement(React.Fragment, null,
                  React.createElement("pre", { style: styles.terminal }, hostOutput || "$ nexus presentation\n> sessionId: "+panel.sessionId+"\n> connect the read-only host bridge to observe bounded PTY output"),
                  React.createElement("div", { style: styles.controls },
                    React.createElement("button", { onClick: () => { void connectHost(); } }, "Connect host"),
                    React.createElement("button", { onClick: () => { void disconnectHost(); } }, "Disconnect view"),
                    React.createElement("button", { onClick: () => parkPanel(panel) }, "Park"),
                    React.createElement("button", { onClick: () => dispatch({ op: "summon", panelId: panel.panelId, targetSurface: "main" }) }, "Summon"),
                    React.createElement("button", { onClick: () => dispatch({ op: "setHome", panelId: panel.panelId, anchor: { ...panel.homeAnchor, layoutRevision: panel.homeAnchor.layoutRevision + 1 } }) }, "Set Home"),
                    React.createElement("span", { style: styles.muted }, "Ctrl+Shift: P park · S summon · B SnapBack · H home"),
                  ),
                ),
              );
            }
            const entry = visibleProfiles.find((candidate) => candidate.panel.panelId === item.panelId);
            if (!entry) return renderPanelChrome(item, item.panelId);
            return renderPanelChrome(entry.panel, entry.label,
              React.createElement(React.Fragment, null,
                React.createElement(TerminalView, { key: entry.attachmentId, host: window.nexusHost, sessionId: entry.panel.sessionId, attachmentId: entry.attachmentId, initialOutput: entry.output, writable: entry.writable }),
                React.createElement("div", { style: styles.controls },
                  React.createElement("button", { onClick: () => parkPanel(entry.panel) }, "Park"),
                  React.createElement("button", { onClick: () => dispatchProfile(entry.panel.panelId, { op: "summon", panelId: entry.panel.panelId, targetSurface: "main" }) }, "Summon"),
                  React.createElement("button", { onClick: () => dispatchProfile(entry.panel.panelId, { op: "setHome", panelId: entry.panel.panelId, anchor: { ...entry.panel.homeAnchor, layoutRevision: entry.panel.homeAnchor.layoutRevision + 1 } }) }, "Set Home"),
                  React.createElement("button", { onClick: () => { void runProfileLifecycle(entry, "interrupt"); } }, "Interrupt"),
                  entry.profile ? React.createElement("button", { onClick: () => { void runProfileLifecycle(entry, "restart"); } }, "Restart") : null,
                  React.createElement("button", { onClick: () => { void runProfileLifecycle(entry, "terminate"); } }, "Terminate"),
                  React.createElement("button", { onClick: () => { void closeProfilePanel(entry); } }, "Close"),
                  lifecycleErrors[entry.panel.panelId] ? React.createElement("span", { style: styles.error }, lifecycleErrors[entry.panel.panelId]) : null,
                ),
              ),
            );
          }),
        ),
      ),
      React.createElement("aside", { style: styles.shelf },
        React.createElement("div", { style: styles.sectionLabel }, "PARKED"),
        shelf.parked.length === 0
          ? React.createElement("div", { style: styles.muted }, "Nothing parked. Parked sessions stay live.")
          : shelf.parked.map((item) => {
            const entry = visibleProfiles.find((candidate) => candidate.panel.panelId === item.panelId);
            const title = item.panelId === panel.panelId ? "Terminal presentation" : (entry?.label ?? item.panelId);
            return renderPanelChrome(item, title,
              React.createElement("div", { style: styles.controls },
                React.createElement("button", { onClick: () => snapBackPanel(item) }, "Restore"),
                React.createElement("span", { style: styles.muted }, "Returns to " + item.homeAnchor.groupId),
              ),
            );
          }),
        React.createElement("div", { style: styles.sectionLabel }, "SESSION SHELF"),
        sessions.length === 0
          ? React.createElement("div", { style: styles.muted }, "No persisted sessions")
          : sessions.map((session) => React.createElement("div", { style: styles.sessionCard, key: session.sessionId },
            React.createElement("strong", null, session.kind),
            React.createElement("span", { style: styles.muted }, "session · "+session.sessionId),
            React.createElement("span", { style: session.process === "running" ? styles.running : styles.muted },
              "● "+session.process+" · "+session.recovery+(session.pid ? " · pid "+session.pid : "")),
          )),
        React.createElement("div", { style: styles.profileControls },
          React.createElement("button", { onClick: () => { void launchProfile({ profileId: "shell", name: "Shell", executable: "shell", args: [] }); } }, "Launch shell"),
          React.createElement("button", { onClick: () => { void launchProfile({ profileId: "claude-code", name: "Claude Code", executable: "claude", args: ["--version"] }); } }, "Launch Claude profile"),
          React.createElement("button", { onClick: () => { void launchProfile({ profileId: "codex-cli", name: "Codex CLI", executable: "codex", args: ["--version"] }); } }, "Launch Codex profile"),
        ),
        React.createElement("div", { style: styles.companionCard },
          React.createElement("div", { style: styles.sectionLabel }, "SSH PROFILES"),
          sshInfo && sshInfo.profiles.length > 0
            ? sshInfo.profiles.map((profile) => React.createElement("button", { key: profile.profileId, onClick: () => { void connectSsh(profile.profileId); } },
              "Connect: " + profile.name + " (" + (profile.user ? profile.user + "@" : "") + profile.host + (profile.remoteTmuxSession ? ", tmux" : "") + ")"))
            : React.createElement("span", { style: styles.muted }, "No profiles yet. Click Edit, add entries like {\"profileId\":\"box\",\"name\":\"My box\",\"host\":\"example.com\",\"user\":\"me\",\"remoteTmuxSession\":\"main\"}, save, then Reload."),
          ...(sshInfo?.errors ?? []).map((message, index) => React.createElement("span", { style: styles.error, key: "ssh-err-" + index }, message)),
          sshError ? React.createElement("span", { style: styles.error }, sshError) : null,
          React.createElement("div", { style: styles.controls },
            React.createElement("button", { onClick: () => { void window.nexusSsh.openFile().then((problem) => { if (problem) setSshError(problem); }); } }, "Edit profiles file"),
            React.createElement("button", { onClick: refreshSsh }, "Reload"),
          ),
        ),
        companionInfo && !companionDismissed ? React.createElement("div", { style: styles.companionCard },
          React.createElement("div", { style: styles.sectionLabel }, "COMPANION (READ-ONLY, " + (companionInfo.mode === "local" ? "LOOPBACK" : companionInfo.mode === "private" ? "PRIVATE NETWORK" : "HTTPS") + ")"),
          React.createElement("span", { style: styles.muted }, companionInfo.url+" · host "+companionInfo.hostId),
          companionInfo.enrollmentToken
            ? React.createElement(React.Fragment, null,
              React.createElement("div", { style: styles.muted }, "Enrollment token (shown once this run):"),
              React.createElement("code", { style: styles.token }, companionInfo.enrollmentToken),
              React.createElement("button", { onClick: () => { void navigator.clipboard.writeText(companionInfo.enrollmentToken ?? ""); } }, "Copy token"))
            : React.createElement("span", { style: styles.muted }, "Token already shown this run."),
          companionInfo.credentialsPath
            ? React.createElement("span", { style: styles.muted }, "Saved (user-only): "+companionInfo.credentialsPath)
            : React.createElement("span", { style: styles.error }, companionInfo.credentialsWarning ?? "No credentials file written."),
          companionInfo.networkWarning ? React.createElement("span", { style: styles.error }, companionInfo.networkWarning) : null,
          React.createElement("span", { style: styles.muted }, "Valid until the app exits; a new token is issued next launch."),
          React.createElement("button", { onClick: () => { void window.nexusCompanion.openNetworkFile(); } }, "Edit network settings (restart to apply)"),
          React.createElement("button", { onClick: () => setCompanionDismissed(true) }, "Hide"),
        ) : null,
      ),
    ),
  );
}

const styles: Record<string, React.CSSProperties> = {
  app: { minHeight: "100vh", padding: "24px 28px", boxSizing: "border-box", background: "#111111", color: "#ffffff", fontFamily: "Segoe UI, Segoe UI Variable, sans-serif" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 },
  eyebrow: { color: "#ffffff", fontSize: 11, letterSpacing: 2.4, fontWeight: 700, opacity: 0.7 },
  title: { margin: "6px 0 0", fontSize: 36, fontWeight: 300, letterSpacing: -0.6 },
  badge: { color: "#111111", background: "#ffffff", padding: "6px 12px", fontSize: 12, fontWeight: 600 },
  switcher: { display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" },
  workspaceTile: { border: "none", color: "#fff", minWidth: 160, minHeight: 72, padding: "12px 14px", textAlign: "left", cursor: "pointer", display: "grid", alignContent: "space-between" },
  workspaceTileName: { fontSize: 18, fontWeight: 600 },
  workspaceTileMeta: { fontSize: 11, opacity: 0.9 },
  workspace: { display: "grid", gridTemplateColumns: "1fr 300px", gap: 12, minHeight: 620 },
  shelf: { background: "#1b1b1b", padding: 16, display: "grid", alignContent: "start", gap: 10 },
  sectionLabel: { color: "#ffffff", fontSize: 11, letterSpacing: 2, fontWeight: 700, margin: "8px 0", opacity: 0.7 },
  sessionCard: { display: "grid", gap: 6, padding: 12, background: "#2b2b2b" },
  muted: { color: "#c8c8c8", fontSize: 12 },
  running: { color: "#a6ef3a", fontSize: 12 },
  error: { color: "#ff8a80", fontSize: 12 },
  companionCard: { display: "grid", gap: 8, marginTop: 8, padding: 12, background: "#2b2b2b", wordBreak: "break-all" },
  token: { padding: 8, background: "#111111", color: "#a6ef3a", fontFamily: "Cascadia Code, Consolas, monospace", fontSize: 12 },
  canvas: { background: "#1b1b1b", padding: 16, minWidth: 0 },
  liveGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 },
  liveTile: { background: "#0072C6", color: "#fff", overflow: "hidden", display: "flex", flexDirection: "column" },
  parkedTile: { background: "#2b2b2b", color: "#fff", overflow: "hidden", display: "flex", flexDirection: "column", cursor: "pointer", border: "2px solid #555" },
  tileHeader: { display: "flex", justifyContent: "space-between", padding: "14px 16px", alignItems: "flex-start" },
  tileState: { fontSize: 12, marginTop: 4, textTransform: "uppercase", letterSpacing: 1, opacity: 0.9 },
  revision: { color: "#fff", fontSize: 12, opacity: 0.8 },
  terminal: { margin: 0, minHeight: 180, padding: 16, color: "#e8ffbf", background: "#0a0a0a", fontFamily: "Cascadia Code, Consolas, monospace", lineHeight: 1.6, fontSize: 13 },
  controls: { display: "flex", gap: 8, padding: 12, flexWrap: "wrap", background: "#0a0a0a" },
  profileControls: { display: "grid", gap: 8 },
};

createRoot(document.getElementById("root")!).render(React.createElement(App));
