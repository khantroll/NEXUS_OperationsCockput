import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CommandEnvelope, PanelCommand, PanelRecord, ProcessState, RecoveryState, WorkspaceRecord } from "../../../packages/contracts/src/index.js";
import { applyPanelCommand } from "../../../packages/core/src/lifecycle.js";
import { metroWorkspaceTiles, partitionMetroPanels } from "../../../packages/core/src/metro-shelf.js";
import { livePreviewSet, summarizePreviewCost, tickPreviewScheduler } from "../../../packages/core/src/metro-preview.js";
import { applyWorkspaceDrop, createWorkspaceRecord, nextWorkspaceName } from "../../../packages/core/src/metro-workspace.js";
import { isLabOrDemoPanel, sessionDisplayName, visibleShelfSessions, type ShelfSession } from "../../../packages/core/src/session-shelf.js";
import { appendPanelPreview, readPanelPreview, seedPanelPreview } from "./preview-buffers.js";
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
    nexusWorkspace: { list: () => Promise<WorkspaceRecord[]>; save: (workspace: WorkspaceRecord) => Promise<void>; onCreateRequested: (listener: () => void) => () => void };
    nexusMetro: {
      previewConfig: () => Promise<{ intervalMs: number; maxConcurrent: number; trace: boolean }>;
      onWindowVisibility: (listener: (payload: { hidden: boolean }) => void) => () => void;
    };
    nexusSsh: {
      list: () => Promise<{ path: string; errors: string[]; profiles: Array<{ profileId: string; name: string; host: string; user?: string; port?: number; remoteTmuxSession?: string }> }>;
      start: (profileId: string) => Promise<{ sessionId: string; pid: number; status: string; outputBytes: number; name: string }>;
      openFile: () => Promise<string | null>;
    };
    nexusCompanion: { openNetworkFile: () => Promise<string | null>; info: () => Promise<{ mode: "local" | "private" | "https"; networkWarning: string | null; url: string; hostId: string; credentialsPath: string | null; credentialsWarning: string | null; enrollmentToken?: string } | null> };
    nexusSessions: {
      list: () => Promise<ShelfSession[]>;
      clearExited: () => Promise<ShelfSession[]>;
      clearLab: () => Promise<ShelfSession[]>;
    };
  }
}

type ProfileSpec = { profileId: string; name: string; executable: "claude" | "codex" | "shell"; args: string[]; cwd?: string };
type TerminalEntry = { panel: PanelRecord; attachmentId: string; output: string; writable: boolean; label: string; profile?: ProfileSpec };

const shellProfile: ProfileSpec = { profileId: "shell", name: "Terminal", executable: "shell", args: [] };
const claudeProfile: ProfileSpec = { profileId: "claude-code", name: "Claude Code", executable: "claude", args: ["--version"] };
const codexProfile: ProfileSpec = { profileId: "codex-cli", name: "Codex CLI", executable: "codex", args: ["--version"] };

function homeAnchor(workspaceId: string, tabIndex: number): PanelRecord["homeAnchor"] {
  return { workspaceId, groupId: "terminals", splitPath: ["root", "center"], tabIndex, fallbackZone: "center", layoutRevision: 1 };
}

function command(panel: PanelRecord, payload: PanelCommand): CommandEnvelope<PanelCommand> {
  return { requestId: crypto.randomUUID(), actorId: "desktop-operator", expectedRevision: panel.revision, payload };
}

function asShelfSession(session: {
  sessionId: string;
  kind: string;
  process: string;
  recovery: string;
  pid?: number;
  label?: string;
  cwd?: string;
}): ShelfSession {
  return {
    sessionId: session.sessionId,
    kind: session.kind,
    process: session.process as ProcessState,
    recovery: session.recovery as RecoveryState,
    ...(session.pid === undefined ? {} : { pid: session.pid }),
    ...(session.label === undefined ? {} : { label: session.label }),
    ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
  };
}

function App(): React.JSX.Element {
  const [terminals, setTerminals] = useState<TerminalEntry[]>([]);
  const [focusedPanelId, setFocusedPanelId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceRecord>({
    workspaceId: "default",
    name: "Default",
    createdAt: "2026-11-15T00:00:00.000Z",
    lastOpenedAt: "2026-11-15T00:00:00.000Z",
  });
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [panelsByWorkspace, setPanelsByWorkspace] = useState<ReadonlyMap<string, PanelRecord[]>>(new Map());
  const [previewConfig, setPreviewConfig] = useState({ intervalMs: 3000, maxConcurrent: 2, trace: false });
  const [osWindowHidden, setOsWindowHidden] = useState(false);
  const [pageHidden, setPageHidden] = useState(document.hidden);
  const [previewSnapshots, setPreviewSnapshots] = useState<Record<string, string>>({});
  const [workspacePrompt, setWorkspacePrompt] = useState<{ name: string; panelId?: string; error?: string } | null>(null);
  const [showHiddenSessions, setShowHiddenSessions] = useState(false);
  const lastPreviewCaptureAt = useRef(new Map<string, number>());
  const previewCostSamples = useRef<number[]>([]);
  const previewRouteRef = useRef<TerminalEntry[]>([]);
  const [companionInfo, setCompanionInfo] = useState<Awaited<ReturnType<Window["nexusCompanion"]["info"]>>>(null);
  const [companionDismissed, setCompanionDismissed] = useState(false);
  const [sshInfo, setSshInfo] = useState<Awaited<ReturnType<Window["nexusSsh"]["list"]>> | null>(null);
  const [sshError, setSshError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ShelfSession[]>([]);
  const [lifecycleErrors, setLifecycleErrors] = useState<Record<string, string>>({});
  const [layoutLoaded, setLayoutLoaded] = useState(false);

  const persistPanel = (nextPanel: PanelRecord): void => {
    void window.nexusLayout.save([nextPanel]).catch(() => undefined);
  };

  const refreshSessions = (): void => {
    void window.nexusSessions.list()
      .then((listed) => setSessions(listed.map(asShelfSession)))
      .catch(() => undefined);
  };

  const attachInteractive = async (sessionId: string): Promise<{ attachmentId: string; replay: string; writable: boolean }> => {
    try {
      return { ...(await window.nexusHost.attach(sessionId, "write")), writable: true };
    } catch {
      return { ...(await window.nexusHost.attach(sessionId, "read")), writable: false };
    }
  };

  const presentSession = async (session: { sessionId: string; pid?: number; status?: string }, label: string, profile?: ProfileSpec): Promise<void> => {
    const attached = await attachInteractive(session.sessionId);
    const panel: PanelRecord = {
      panelId: "profile-panel-" + session.sessionId,
      sessionId: session.sessionId,
      workspaceId: workspace.workspaceId,
      placement: "docked",
      homeAnchor: homeAnchor(workspace.workspaceId, terminals.length),
      revision: 1,
    };
    seedPanelPreview(panel.panelId, attached.replay);
    setTerminals((current) => [...current, { panel, attachmentId: attached.attachmentId, output: attached.replay, writable: attached.writable, label, ...(profile === undefined ? {} : { profile }) }]);
    setFocusedPanelId(panel.panelId);
    persistPanel(panel);
    refreshSessions();
  };

  const launchProfile = async (profile: ProfileSpec): Promise<void> => {
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

  const runLifecycle = async (entry: TerminalEntry, operation: "interrupt" | "restart" | "terminate"): Promise<void> => {
    try {
      if (operation === "interrupt") {
        const result = await window.nexusHost.interrupt(entry.panel.sessionId) as { status: string };
        setSessions((current) => current.map((candidate) => candidate.sessionId === entry.panel.sessionId ? { ...candidate, process: result.status as ProcessState } : candidate));
        return;
      }
      if (operation === "restart" && entry.profile) {
        await window.nexusHost.detach(entry.attachmentId);
        await window.nexusHost.restartProfile(entry.panel.sessionId, entry.profile);
        const attached = await attachInteractive(entry.panel.sessionId);
        seedPanelPreview(entry.panel.panelId, attached.replay);
        setTerminals((current) => current.map((candidate) => candidate.panel.panelId === entry.panel.panelId
          ? { ...candidate, attachmentId: attached.attachmentId, output: attached.replay, writable: attached.writable } : candidate));
        refreshSessions();
        setLifecycleErrors((current) => { const next = { ...current }; delete next[entry.panel.panelId]; return next; });
        return;
      }
      if (operation === "terminate") {
        await window.nexusHost.terminate(entry.panel.sessionId, `terminate:${entry.panel.sessionId}`);
        setTerminals((current) => current.filter((candidate) => candidate.panel.panelId !== entry.panel.panelId));
        refreshSessions();
      }
    } catch (error) {
      setLifecycleErrors((current) => ({ ...current, [entry.panel.panelId]: error instanceof Error ? error.message : String(error) }));
      try {
        await window.nexusHost.detach(entry.attachmentId).catch(() => undefined);
        discardTerminalBuffer(entry.attachmentId);
        const attached = await attachInteractive(entry.panel.sessionId);
        setTerminals((current) => current.map((candidate) => candidate.panel.panelId === entry.panel.panelId
          ? { ...candidate, attachmentId: attached.attachmentId, output: attached.replay, writable: attached.writable } : candidate));
      } catch { /* preserve the visible failure */ }
    }
  };

  const closeTerminal = async (entry: TerminalEntry): Promise<void> => {
    await window.nexusHost.detach(entry.attachmentId).catch(() => undefined);
    discardTerminalBuffer(entry.attachmentId);
    await window.nexusHost.terminate(entry.panel.sessionId, `close:${entry.panel.sessionId}`).catch(() => undefined);
    setTerminals((current) => current.filter((candidate) => candidate.panel.panelId !== entry.panel.panelId));
    refreshSessions();
  };

  const dispatch = (panelId: string, payload: PanelCommand): void => {
    setTerminals((current) => current.map((entry) => {
      if (entry.panel.panelId !== panelId) return entry;
      const transition = applyPanelCommand(entry.panel, command(entry.panel, payload));
      if (!transition.result.accepted) return entry;
      persistPanel(transition.record);
      return { ...entry, panel: transition.record };
    }));
  };

  useEffect(() => {
    refreshSsh();
  }, []);
  useEffect(() => {
    void window.nexusCompanion.info().then(setCompanionInfo).catch(() => setCompanionInfo(null));
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || !event.shiftKey || event.altKey) return;
      const target = terminals.find((entry) => entry.panel.panelId === focusedPanelId) ?? terminals.find((entry) => entry.panel.workspaceId === workspace.workspaceId);
      if (!target) return;
      if (event.key === "p") { event.preventDefault(); dispatch(target.panel.panelId, { op: "park", panelId: target.panel.panelId }); }
      if (event.key === "s") { event.preventDefault(); dispatch(target.panel.panelId, { op: "summon", panelId: target.panel.panelId, targetSurface: "main" }); }
      if (event.key === "b") { event.preventDefault(); dispatch(target.panel.panelId, { op: "snapBack", panelId: target.panel.panelId }); }
      if (event.key === "h") {
        event.preventDefault();
        dispatch(target.panel.panelId, { op: "setHome", panelId: target.panel.panelId, anchor: { ...target.panel.homeAnchor, layoutRevision: target.panel.homeAnchor.layoutRevision + 1 } });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [terminals, focusedPanelId, workspace.workspaceId]);

  useEffect(() => {
    void Promise.all([
      window.nexusWorkspace.list(),
      window.nexusSessions.list(),
    ]).then(async ([listedWorkspaces, persistedSessions]) => {
      setSessions(persistedSessions.map(asShelfSession));
      setWorkspaces(listedWorkspaces);
      const current = listedWorkspaces.find((candidate) => candidate.workspaceId === "default");
      if (current) setWorkspace({ ...current, lastOpenedAt: new Date().toISOString() });
      else {
        const created = { ...workspace, lastOpenedAt: new Date().toISOString() };
        setWorkspace(created);
        setWorkspaces((existing) => existing.some((item) => item.workspaceId === created.workspaceId) ? existing : [...existing, created]);
        void window.nexusWorkspace.save(created);
      }
      const listed = new Map<string, PanelRecord[]>();
      const recoverWorkspace = listedWorkspaces.length > 0 ? listedWorkspaces : [{ workspaceId: "default", name: "Default", createdAt: "", lastOpenedAt: "" }];
      await Promise.all(recoverWorkspace.map(async (item) => {
        const panels = (await window.nexusLayout.list(item.workspaceId)).filter((panel) => !isLabOrDemoPanel(panel.panelId));
        listed.set(item.workspaceId, panels);
        await Promise.all(panels.map(async (savedPanel) => {
          try {
            const attached = await attachInteractive(savedPanel.sessionId);
            const match = persistedSessions.map(asShelfSession).find((session) => session.sessionId === savedPanel.sessionId);
            seedPanelPreview(savedPanel.panelId, attached.replay);
            const recovered: TerminalEntry = {
              panel: savedPanel,
              attachmentId: attached.attachmentId,
              output: attached.replay,
              writable: attached.writable,
              label: match ? sessionDisplayName(match) : "Recovered terminal",
            };
            setTerminals((currentTerminals) => currentTerminals.some((entry) => entry.panel.panelId === savedPanel.panelId) ? currentTerminals : [...currentTerminals, recovered]);
          } catch { /* session is gone; leave the saved panel out of the live set */ }
        }));
      }));
      setPanelsByWorkspace(listed);
      setLayoutLoaded(true);
    }).catch(() => setLayoutLoaded(true));
  }, []);

  useEffect(() => window.nexusHost.onData(routeTerminalData), []);
  useEffect(() => {
    void window.nexusMetro.previewConfig().then(setPreviewConfig).catch(() => undefined);
  }, []);
  useEffect(() => window.nexusWorkspace.onCreateRequested(() => {
    setWorkspacePrompt({ name: nextWorkspaceName(workspaces) });
  }), [workspaces]);
  useEffect(() => window.nexusMetro.onWindowVisibility((payload) => setOsWindowHidden(payload.hidden)), []);
  useEffect(() => {
    const sync = (): void => setPageHidden(document.hidden);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  previewRouteRef.current = terminals;
  useEffect(() => window.nexusHost.onData((payload) => {
    const entry = previewRouteRef.current.find((item) => item.attachmentId === payload.attachmentId);
    if (entry) appendPanelPreview(entry.panel.panelId, payload.data);
  }), []);

  useEffect(() => {
    const currentPanels = terminals.map((entry) => entry.panel).filter((item) => item.workspaceId === workspace.workspaceId);
    setPanelsByWorkspace((current) => new Map(current).set(workspace.workspaceId, currentPanels));
  }, [terminals, workspace.workspaceId]);

  const visibleTerminals = terminals.filter((entry) => entry.panel.workspaceId === workspace.workspaceId);
  const shelf = partitionMetroPanels(visibleTerminals.map((entry) => entry.panel));
  const tiles = metroWorkspaceTiles(workspaces, workspace.workspaceId, panelsByWorkspace);
  const tileColors = ["#0072C6", "#00A4A6", "#A7008F", "#DC572E", "#8CBD18", "#F0A30A"];
  const previewPaused = osWindowHidden || pageHidden;
  const parkedIds = shelf.parked.map((item) => item.panelId);
  const livePreviews = livePreviewSet(parkedIds, previewConfig.maxConcurrent, { paused: false, windowHidden: previewPaused });
  const visibleSessions = visibleShelfSessions(sessions, showHiddenSessions);

  useEffect(() => {
    const capture = (): void => {
      const due = tickPreviewScheduler({
        parkedPanelIds: parkedIds,
        lastCaptureAt: lastPreviewCaptureAt.current,
        now: Date.now(),
        intervalMs: previewConfig.intervalMs,
        cap: previewConfig.maxConcurrent,
        paused: false,
        windowHidden: previewPaused,
      });
      if (due.length === 0) return;
      const started = performance.now();
      setPreviewSnapshots((current) => {
        const next = { ...current };
        for (const panelId of due) next[panelId] = readPanelPreview(panelId) || current[panelId] || "";
        return next;
      });
      const elapsed = performance.now() - started;
      const capturedAt = Date.now();
      for (const panelId of due) lastPreviewCaptureAt.current.set(panelId, capturedAt);
      previewCostSamples.current = [...previewCostSamples.current, elapsed].slice(-20);
      if (previewConfig.trace) {
        console.log("metro preview capture", { due, intervalMs: previewConfig.intervalMs, cap: previewConfig.maxConcurrent, ...summarizePreviewCost(previewCostSamples.current) });
      }
    };
    capture();
    const timer = window.setInterval(capture, Math.min(previewConfig.intervalMs, 1000));
    return () => window.clearInterval(timer);
  }, [parkedIds.join(","), previewPaused, previewConfig.intervalMs, previewConfig.maxConcurrent, previewConfig.trace]);

  function openWorkspace(record: WorkspaceRecord): void {
    const next = { ...record, lastOpenedAt: new Date().toISOString() };
    setWorkspace(next);
    void window.nexusWorkspace.save(next).catch(() => undefined);
  }

  function applyMovedPanel(nextPanel: PanelRecord): void {
    setTerminals((current) => current.map((entry) => entry.panel.panelId === nextPanel.panelId ? { ...entry, panel: nextPanel } : entry));
    persistPanel(nextPanel);
  }

  function findPanel(panelId: string): PanelRecord | undefined {
    return terminals.find((entry) => entry.panel.panelId === panelId)?.panel;
  }

  function submitWorkspacePrompt(): void {
    if (!workspacePrompt) return;
    try {
      const createdAt = new Date().toISOString();
      if (workspacePrompt.panelId) {
        const source = findPanel(workspacePrompt.panelId);
        if (!source) {
          setWorkspacePrompt(null);
          return;
        }
        const result = applyWorkspaceDrop(source, {
          kind: "new",
          name: workspacePrompt.name,
          workspaceId: crypto.randomUUID(),
          now: createdAt,
        }, workspaces);
        if (result.workspace) {
          setWorkspaces(result.workspaces);
          void window.nexusWorkspace.save(result.workspace).catch(() => undefined);
          applyMovedPanel(result.panel);
          openWorkspace(result.workspace);
        }
      } else {
        const created = createWorkspaceRecord({
          name: workspacePrompt.name,
          now: createdAt,
          workspaceId: crypto.randomUUID(),
        });
        setWorkspaces((current) => current.some((item) => item.workspaceId === created.workspaceId) ? current : [...current, created]);
        void window.nexusWorkspace.save(created).catch(() => undefined);
        openWorkspace(created);
      }
      setWorkspacePrompt(null);
    } catch (error) {
      setWorkspacePrompt({ ...workspacePrompt, error: error instanceof Error ? error.message : String(error) });
    }
  }

  function dropOnWorkspace(panelId: string, target: "new" | string): void {
    const source = findPanel(panelId);
    if (!source) return;
    if (target === "new") {
      setWorkspacePrompt({ name: nextWorkspaceName(workspaces), panelId });
      return;
    }
    try {
      applyMovedPanel(applyWorkspaceDrop(source, { kind: "existing", workspaceId: target }, workspaces).panel);
    } catch { /* invalid drop */ }
  }

  const panelDragType = "application/x-nexus-panel";
  function startPanelDrag(event: React.DragEvent, panelId: string): void {
    event.dataTransfer.setData(panelDragType, panelId);
    event.dataTransfer.setData("text/plain", panelId);
    event.dataTransfer.effectAllowed = "move";
  }
  function acceptPanelDrop(event: React.DragEvent): void {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }
  function droppedPanelId(event: React.DragEvent): string | null {
    event.preventDefault();
    return event.dataTransfer.getData(panelDragType) || event.dataTransfer.getData("text/plain") || null;
  }

  function snapBackPanel(target: PanelRecord): void {
    dispatch(target.panelId, { op: "snapBack", panelId: target.panelId });
  }

  function parkPanel(target: PanelRecord): void {
    dispatch(target.panelId, { op: "park", panelId: target.panelId });
  }

  function renderPanelChrome(target: PanelRecord, title: string, extra?: React.ReactNode): React.JSX.Element {
    const parked = target.placement === "parked";
    return React.createElement("article", {
      key: target.panelId,
      style: parked ? styles.parkedTile : styles.liveTile,
      draggable: true,
      "data-panel-id": target.panelId,
      "data-panel-placement": target.placement,
      "data-panel-revision": target.revision,
      onClick: () => setFocusedPanelId(target.panelId),
      onDragStart: (event: React.DragEvent) => startPanelDrag(event, target.panelId),
      onDoubleClick: parked ? () => snapBackPanel(target) : undefined,
      onContextMenu: parked ? (event: React.MouseEvent) => { event.preventDefault(); snapBackPanel(target); } : undefined,
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

  const launchers = React.createElement("div", { style: styles.headerActions },
    React.createElement("button", { type: "button", style: styles.headerButton, onClick: () => { void launchProfile(shellProfile); } }, "New Terminal"),
    React.createElement("button", { type: "button", style: styles.headerButton, onClick: () => { void launchProfile(claudeProfile); } }, "Claude"),
    React.createElement("button", { type: "button", style: styles.headerButton, onClick: () => { void launchProfile(codexProfile); } }, "Codex"),
    ...(sshInfo?.profiles ?? []).map((profile) => React.createElement("button", {
      key: profile.profileId,
      type: "button",
      style: styles.headerButton,
      onClick: () => { void connectSsh(profile.profileId); },
    }, "SSH: " + profile.name)),
    React.createElement("button", { type: "button", style: styles.headerButton, onClick: () => { void window.nexusSsh.openFile().then((problem) => { if (problem) setSshError(problem); }); } }, "Edit SSH"),
    React.createElement("span", { style: styles.badge }, window.nexusShell.version),
  );

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
      launchers,
    ),
    React.createElement("nav", { style: styles.switcher, "aria-label": "Workspaces" },
      tiles.length === 0
        ? React.createElement("div", { style: styles.workspaceTile, "data-current": "true" }, workspace.name)
        : tiles.map((tile, index) => React.createElement("button", {
          key: tile.workspaceId,
          type: "button",
          style: { ...styles.workspaceTile, background: tileColors[index % tileColors.length], outline: tile.current ? "3px solid #fff" : "none" },
          "data-current": tile.current ? "true" : "false",
          "data-drop-target": "workspace",
          "data-workspace-id": tile.workspaceId,
          onDragOver: acceptPanelDrop,
          onDrop: (event: React.DragEvent) => {
            const panelId = droppedPanelId(event);
            if (panelId) dropOnWorkspace(panelId, tile.workspaceId);
          },
          onClick: () => {
            const record = workspaces.find((item) => item.workspaceId === tile.workspaceId);
            if (record) openWorkspace(record);
          },
        },
          React.createElement("span", { style: styles.workspaceTileName }, tile.name),
          React.createElement("span", { style: styles.workspaceTileMeta }, tile.liveCount + " live · " + tile.parkedCount + " parked"),
        )),
      React.createElement("button", {
        type: "button",
        style: styles.newWorkspaceTile,
        "data-drop-target": "new-workspace",
        onClick: () => setWorkspacePrompt({ name: nextWorkspaceName(workspaces) }),
        onDragOver: acceptPanelDrop,
        onDrop: (event: React.DragEvent) => {
          const panelId = droppedPanelId(event);
          if (panelId) dropOnWorkspace(panelId, "new");
        },
      },
        React.createElement("span", { style: styles.workspaceTileName }, "New workspace"),
        React.createElement("span", { style: styles.workspaceTileMeta }, "Drop a tile here, or click to name one"),
      ),
    ),
    React.createElement(
      "section",
      { style: styles.workspace },
      React.createElement("section", { style: styles.canvas },
        React.createElement("div", { style: styles.sectionLabel }, "LIVE WORKSPACE"),
        React.createElement("div", { style: styles.liveGrid },
          shelf.live.length === 0
            ? React.createElement("div", { style: styles.emptyState },
              React.createElement("div", { style: styles.muted }, layoutLoaded ? "No live terminals in this workspace. Start one, or restore a parked window." : "Loading workspace…"),
              layoutLoaded ? React.createElement("button", { type: "button", onClick: () => { void launchProfile(shellProfile); } }, "New Terminal") : null,
            )
            : shelf.live.map((item) => {
              const entry = visibleTerminals.find((candidate) => candidate.panel.panelId === item.panelId);
              if (!entry) return renderPanelChrome(item, item.panelId);
              return renderPanelChrome(entry.panel, entry.label,
                React.createElement(React.Fragment, null,
                  React.createElement(TerminalView, { key: entry.attachmentId, host: window.nexusHost, sessionId: entry.panel.sessionId, attachmentId: entry.attachmentId, initialOutput: entry.output, writable: entry.writable }),
                  React.createElement("div", { style: styles.controls },
                    React.createElement("button", { onClick: () => parkPanel(entry.panel) }, "Park"),
                    React.createElement("button", { onClick: () => dispatch(entry.panel.panelId, { op: "summon", panelId: entry.panel.panelId, targetSurface: "main" }) }, "Summon"),
                    React.createElement("button", { onClick: () => dispatch(entry.panel.panelId, { op: "setHome", panelId: entry.panel.panelId, anchor: { ...entry.panel.homeAnchor, layoutRevision: entry.panel.homeAnchor.layoutRevision + 1 } }) }, "Set Home"),
                    React.createElement("button", { onClick: () => { void runLifecycle(entry, "interrupt"); } }, "Interrupt"),
                    entry.profile ? React.createElement("button", { onClick: () => { void runLifecycle(entry, "restart"); } }, "Restart") : null,
                    React.createElement("button", { onClick: () => { void runLifecycle(entry, "terminate"); } }, "Terminate"),
                    React.createElement("button", { onClick: () => { void closeTerminal(entry); } }, "Close"),
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
            const entry = visibleTerminals.find((candidate) => candidate.panel.panelId === item.panelId);
            const title = entry?.label ?? item.panelId;
            const mode = previewPaused ? "paused" : (livePreviews.includes(item.panelId) ? "live" : "static");
            const snapshot = previewSnapshots[item.panelId] || readPanelPreview(item.panelId);
            const placeholder = mode === "paused" ? "Session still live · preview paused" : "Session still live · preview pending";
            return renderPanelChrome(item, title,
              React.createElement(React.Fragment, null,
                React.createElement("pre", { style: styles.preview, "data-preview-mode": mode }, snapshot || placeholder),
                React.createElement("div", { style: styles.controls },
                  React.createElement("button", { onClick: (event: React.MouseEvent) => { event.stopPropagation(); snapBackPanel(item); } }, "Restore"),
                  React.createElement("span", { style: styles.muted }, "Double-click to restore · returns to " + item.homeAnchor.groupId),
                ),
              ),
            );
          }),
        React.createElement("div", { style: styles.sectionLabel }, "SESSION SHELF"),
        React.createElement("div", { style: styles.shelfToolbar },
          React.createElement("label", { style: styles.muted },
            React.createElement("input", {
              type: "checkbox",
              checked: showHiddenSessions,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => setShowHiddenSessions(event.target.checked),
            }),
            " Show exited",
          ),
          React.createElement("button", { type: "button", onClick: () => { void window.nexusSessions.clearExited().then((listed) => setSessions(listed.map(asShelfSession))); } }, "Clear exited"),
          React.createElement("button", { type: "button", onClick: () => { void window.nexusSessions.clearLab().then((listed) => setSessions(listed.map(asShelfSession))); } }, "Clear lab/demo sessions"),
        ),
        visibleSessions.length === 0
          ? React.createElement("div", { style: styles.muted }, showHiddenSessions ? "No persisted sessions" : "No active sessions. Exited and relaunch-only rows are hidden.")
          : visibleSessions.map((session) => React.createElement("div", { style: styles.sessionCard, key: session.sessionId },
            React.createElement("strong", null, sessionDisplayName(session)),
            React.createElement("span", { style: styles.muted }, session.kind + " · " + session.sessionId),
            React.createElement("span", { style: session.process === "running" ? styles.running : styles.muted },
              "● "+session.process+" · "+session.recovery+(session.pid ? " · pid "+session.pid : "")),
          )),
        sshError ? React.createElement("span", { style: styles.error }, sshError) : null,
        ...(sshInfo?.errors ?? []).map((message, index) => React.createElement("span", { style: styles.error, key: "ssh-err-" + index }, message)),
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
    workspacePrompt ? React.createElement("div", { style: styles.modalBackdrop, role: "dialog", "aria-modal": "true", "aria-label": "New workspace" },
      React.createElement("form", {
        style: styles.modal,
        onSubmit: (event: React.FormEvent) => { event.preventDefault(); submitWorkspacePrompt(); },
      },
        React.createElement("div", { style: styles.sectionLabel }, "NEW WORKSPACE"),
        React.createElement("input", {
          autoFocus: true,
          value: workspacePrompt.name,
          "aria-label": "Workspace name",
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setWorkspacePrompt({ ...workspacePrompt, name: event.target.value, error: undefined }),
          style: styles.modalInput,
        }),
        workspacePrompt.error ? React.createElement("div", { style: styles.error }, workspacePrompt.error) : null,
        workspacePrompt.panelId ? React.createElement("div", { style: styles.muted }, "The dropped window will move into this workspace.") : null,
        React.createElement("div", { style: styles.controls },
          React.createElement("button", { type: "submit" }, "Create"),
          React.createElement("button", { type: "button", onClick: () => setWorkspacePrompt(null) }, "Cancel"),
        ),
      ),
    ) : null,
  );
}

const styles: Record<string, React.CSSProperties> = {
  app: { minHeight: "100vh", padding: "24px 28px", boxSizing: "border-box", background: "#111111", color: "#ffffff", fontFamily: "Segoe UI, Segoe UI Variable, sans-serif" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 16, flexWrap: "wrap" },
  headerActions: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end" },
  headerButton: { border: "none", background: "#0072C6", color: "#fff", padding: "8px 12px", cursor: "pointer", fontWeight: 600 },
  eyebrow: { color: "#ffffff", fontSize: 11, letterSpacing: 2.4, fontWeight: 700, opacity: 0.7 },
  title: { margin: "6px 0 0", fontSize: 36, fontWeight: 300, letterSpacing: -0.6 },
  badge: { color: "#111111", background: "#ffffff", padding: "6px 12px", fontSize: 12, fontWeight: 600 },
  switcher: { display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" },
  workspaceTile: { border: "none", color: "#fff", minWidth: 160, minHeight: 72, padding: "12px 14px", textAlign: "left", cursor: "pointer", display: "grid", alignContent: "space-between" },
  newWorkspaceTile: { border: "2px dashed #666", color: "#fff", background: "transparent", minWidth: 160, minHeight: 72, padding: "12px 14px", textAlign: "left", cursor: "pointer", display: "grid", alignContent: "space-between" },
  workspaceTileName: { fontSize: 18, fontWeight: 600 },
  workspaceTileMeta: { fontSize: 11, opacity: 0.9 },
  workspace: { display: "grid", gridTemplateColumns: "1fr 300px", gap: 12, minHeight: 620 },
  shelf: { background: "#1b1b1b", padding: 16, display: "grid", alignContent: "start", gap: 10 },
  shelfToolbar: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" },
  sectionLabel: { color: "#ffffff", fontSize: 11, letterSpacing: 2, fontWeight: 700, margin: "8px 0", opacity: 0.7 },
  sessionCard: { display: "grid", gap: 6, padding: 12, background: "#2b2b2b" },
  muted: { color: "#c8c8c8", fontSize: 12 },
  running: { color: "#a6ef3a", fontSize: 12 },
  error: { color: "#ff8a80", fontSize: 12 },
  companionCard: { display: "grid", gap: 8, marginTop: 8, padding: 12, background: "#2b2b2b", wordBreak: "break-all" },
  token: { padding: 8, background: "#111111", color: "#a6ef3a", fontFamily: "Cascadia Code, Consolas, monospace", fontSize: 12 },
  canvas: { background: "#1b1b1b", padding: 16, minWidth: 0 },
  liveGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 },
  emptyState: { display: "grid", gap: 12, padding: 24, background: "#2b2b2b", alignContent: "center", justifyItems: "start" },
  liveTile: { background: "#0072C6", color: "#fff", overflow: "hidden", display: "flex", flexDirection: "column" },
  parkedTile: { background: "#2b2b2b", color: "#fff", overflow: "hidden", display: "flex", flexDirection: "column", cursor: "pointer", border: "2px solid #555" },
  tileHeader: { display: "flex", justifyContent: "space-between", padding: "14px 16px", alignItems: "flex-start" },
  tileState: { fontSize: 12, marginTop: 4, textTransform: "uppercase", letterSpacing: 1, opacity: 0.9 },
  revision: { color: "#fff", fontSize: 12, opacity: 0.8 },
  preview: { margin: 0, minHeight: 88, maxHeight: 120, overflow: "hidden", padding: "8px 10px", color: "#d8f5e6", background: "#0a0a0a", fontFamily: "Cascadia Code, Consolas, monospace", fontSize: 11, lineHeight: 1.4, pointerEvents: "none", whiteSpace: "pre-wrap", wordBreak: "break-word" },
  modalBackdrop: { position: "fixed", inset: 0, background: "#00000099", display: "grid", placeItems: "center", zIndex: 20 },
  modal: { background: "#1b1b1b", padding: 24, minWidth: 320, display: "grid", gap: 12, border: "1px solid #444" },
  modalInput: { padding: "8px 10px", fontSize: 16, background: "#111", color: "#fff", border: "1px solid #555" },
  controls: { display: "flex", gap: 8, padding: 12, flexWrap: "wrap", background: "#0a0a0a" },
};

createRoot(document.getElementById("root")!).render(React.createElement(App));
