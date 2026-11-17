import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CommandEnvelope, PanelCommand, PanelRecord, WorkspaceRecord } from "../../../packages/contracts/src/index.js";
import { applyPanelCommand } from "../../../packages/core/src/lifecycle.js";
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
    nexusCompanion: { info: () => Promise<{ url: string; hostId: string; credentialsPath: string | null; credentialsWarning: string | null; enrollmentToken?: string } | null> };
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
        const current = workspaces.find((candidate) => candidate.workspaceId === "default");
        if (current) setWorkspace({ ...current, lastOpenedAt: new Date().toISOString() });
        else {
          const created = { ...workspace, lastOpenedAt: new Date().toISOString() };
          setWorkspace(created);
          void window.nexusWorkspace.save(created);
        }
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

  return React.createElement(
    "main",
    { style: styles.app },
    React.createElement(
      "header",
      { style: styles.header },
      React.createElement("div", null,
        React.createElement("div", { style: styles.eyebrow }, "NEXUS OPERATIONS COCKPIT"),
        React.createElement("h1", { style: styles.title }, "Command workspace"),
      ),
      React.createElement("span", { style: styles.badge }, window.nexusShell.version),
    ),
    React.createElement(
      "section",
      { style: styles.workspace },
      React.createElement("aside", { style: styles.shelf },
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
          React.createElement("div", { style: styles.sectionLabel }, "COMPANION (READ-ONLY, LOOPBACK)"),
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
          React.createElement("span", { style: styles.muted }, "Valid until the app exits; a new token is issued next launch."),
          React.createElement("button", { onClick: () => setCompanionDismissed(true) }, "Hide"),
        ) : null,
      ),
      React.createElement("section", { style: styles.canvas },
        React.createElement("div", { style: styles.sectionLabel }, "WORKSPACE / "+workspace.name.toUpperCase()),
          React.createElement("article", {
            style: styles.panel,
            "data-panel-id": panel.panelId,
            "data-panel-placement": panel.placement,
            "data-panel-revision": panel.revision,
          },
          React.createElement("div", { style: styles.panelHeader },
            React.createElement("div", null,
              React.createElement("strong", null, "Terminal presentation"),
              React.createElement("div", { style: styles.muted }, "presentation state: "+panel.placement),
            ),
            React.createElement("span", { style: styles.revision }, "rev "+panel.revision),
          ),
          profilePanels.map((entry) => React.createElement("article", {
            key: entry.panel.panelId,
            style: styles.panel,
            "data-panel-id": entry.panel.panelId,
            "data-panel-placement": entry.panel.placement,
            "data-panel-revision": entry.panel.revision,
          },
            React.createElement("div", { style: styles.panelHeader },
              React.createElement("div", null,
                React.createElement("strong", null, entry.label),
                React.createElement("div", { style: styles.muted }, "presentation state: "+entry.panel.placement),
              ),
              React.createElement("span", { style: styles.revision }, "rev "+entry.panel.revision),
            ),
            React.createElement(TerminalView, { key: entry.attachmentId, host: window.nexusHost, sessionId: entry.panel.sessionId, attachmentId: entry.attachmentId, initialOutput: entry.output, writable: entry.writable }),
            React.createElement("div", { style: styles.controls },
              React.createElement("button", { onClick: () => dispatchProfile(entry.panel.panelId, { op: "park", panelId: entry.panel.panelId }) }, "Park"),
              React.createElement("button", { onClick: () => dispatchProfile(entry.panel.panelId, { op: "summon", panelId: entry.panel.panelId, targetSurface: "main" }) }, "Summon"),
              React.createElement("button", { onClick: () => dispatchProfile(entry.panel.panelId, { op: "snapBack", panelId: entry.panel.panelId }) }, "SnapBack"),
              React.createElement("button", { onClick: () => dispatchProfile(entry.panel.panelId, { op: "setHome", panelId: entry.panel.panelId, anchor: { ...entry.panel.homeAnchor, layoutRevision: entry.panel.homeAnchor.layoutRevision + 1 } }) }, "Set Home"),
              React.createElement("button", { onClick: () => { void runProfileLifecycle(entry, "interrupt"); } }, "Interrupt"),
              entry.profile ? React.createElement("button", { onClick: () => { void runProfileLifecycle(entry, "restart"); } }, "Restart") : null,
              React.createElement("button", { onClick: () => { void runProfileLifecycle(entry, "terminate"); } }, "Terminate"),
              React.createElement("button", { onClick: () => { void closeProfilePanel(entry); } }, "Close"),
              lifecycleErrors[entry.panel.panelId] ? React.createElement("span", { style: styles.error }, lifecycleErrors[entry.panel.panelId]) : null,
            ),
          )),
          React.createElement("pre", { style: styles.terminal }, hostOutput || "$ nexus presentation\n> sessionId: "+panel.sessionId+"\n> connect the read-only host bridge to observe bounded PTY output"),
          React.createElement("div", { style: styles.controls },
            React.createElement("button", { onClick: () => { void connectHost(); } }, "Connect host"),
            React.createElement("button", { onClick: () => { void disconnectHost(); } }, "Disconnect view"),
            React.createElement("button", { onClick: () => dispatch({ op: "park", panelId: panel.panelId }) }, "Park"),
            React.createElement("button", { onClick: () => dispatch({ op: "summon", panelId: panel.panelId, targetSurface: "main" }) }, "Summon"),
            React.createElement("button", { onClick: () => dispatch({ op: "snapBack", panelId: panel.panelId }) }, "SnapBack"),
            React.createElement("button", { onClick: () => dispatch({ op: "setHome", panelId: panel.panelId, anchor: { ...panel.homeAnchor, layoutRevision: panel.homeAnchor.layoutRevision + 1 } }) }, "Set Home"),
            React.createElement("span", { style: styles.muted }, "Ctrl+Shift: P park · S summon · B SnapBack · H home"),
          ),
        ),
      ),
    ),
  );
}

const styles: Record<string, React.CSSProperties> = {
  app: { minHeight: "100vh", padding: "28px 34px", boxSizing: "border-box", background: "#0b1020", color: "#e8ecf7", fontFamily: "Inter, Segoe UI, sans-serif" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 28 },
  eyebrow: { color: "#7c8cff", fontSize: 11, letterSpacing: 2.2, fontWeight: 700 },
  title: { margin: "7px 0 0", fontSize: 30, letterSpacing: -0.8 },
  badge: { color: "#aab5cc", border: "1px solid #293454", borderRadius: 999, padding: "7px 11px", fontSize: 12 },
  workspace: { display: "grid", gridTemplateColumns: "250px 1fr", gap: 18, minHeight: 620 },
  shelf: { background: "#11182b", border: "1px solid #202b48", borderRadius: 14, padding: 18 },
  sectionLabel: { color: "#7380a1", fontSize: 10, letterSpacing: 1.8, fontWeight: 700, marginBottom: 14 },
  sessionCard: { display: "grid", gap: 7, padding: 13, borderRadius: 10, background: "#17213a", border: "1px solid #334266" },
  muted: { color: "#8491b0", fontSize: 12 },
  running: { color: "#61d6a2", fontSize: 12 },
  error: { color: "#ff9b9b", fontSize: 12 },
  companionCard: { display: "grid", gap: 8, marginTop: 16, padding: 13, borderRadius: 10, background: "#17213a", border: "1px solid #334266", wordBreak: "break-all" },
  token: { padding: 8, borderRadius: 6, background: "#080d18", color: "#a6f3c5", fontFamily: "Cascadia Code, Consolas, monospace", fontSize: 12 },
  canvas: { background: "#0e1527", border: "1px solid #202b48", borderRadius: 14, padding: 22 },
  panel: { maxWidth: 780, background: "#11182b", border: "1px solid #2b385b", borderRadius: 12, overflow: "hidden", boxShadow: "0 14px 50px #05081480" },
  panelHeader: { display: "flex", justifyContent: "space-between", padding: "16px 18px", borderBottom: "1px solid #202b48" },
  revision: { color: "#7180a5", fontSize: 12 },
  terminal: { margin: 0, minHeight: 220, padding: 20, color: "#a6f3c5", background: "#080d18", fontFamily: "Cascadia Code, Consolas, monospace", lineHeight: 1.7, fontSize: 13 },
  controls: { display: "flex", gap: 8, padding: 14 },
};

createRoot(document.getElementById("root")!).render(React.createElement(App));
