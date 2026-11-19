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
  const [shellView, setShellView] = useState<"home" | "sessions" | "settings">("home");
  const [clock, setClock] = useState(() => new Date().toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }));
  useEffect(() => {
    const tick = (): void => setClock(new Date().toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }));
    const id = window.setInterval(tick, 15000);
    return () => window.clearInterval(id);
  }, []);
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
  const tileColors = ["#00A4E8", "#00B3A4", "#2BB56A", "#0078D4", "#E4572E", "#C7A000"];
  const parkedColors = ["#6B3FA0", "#008B9A", "#E4572E", "#0078D4", "#2BB56A", "#C7A000"];
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

  function renderLiveWindow(target: PanelRecord, title: string, extra?: React.ReactNode): React.JSX.Element {
    const entry = visibleTerminals.find((candidate) => candidate.panel.panelId === target.panelId);
    return React.createElement("article", {
      key: target.panelId,
      style: styles.liveWindow,
      draggable: true,
      "data-panel-id": target.panelId,
      "data-panel-placement": target.placement,
      "data-panel-revision": target.revision,
      onClick: () => setFocusedPanelId(target.panelId),
      onDragStart: (event: React.DragEvent) => startPanelDrag(event, target.panelId),
    },
      React.createElement("div", { style: styles.windowTitleBar },
        React.createElement("span", { style: styles.windowGlyph }, ">_"),
        React.createElement("strong", { style: styles.windowTitle }, title),
        React.createElement("span", { style: styles.runningPill }, "RUNNING"),
        React.createElement("span", { style: styles.windowSpacer }),
        React.createElement("button", { type: "button", title: "Park", style: styles.windowControl, onClick: (event: React.MouseEvent) => { event.stopPropagation(); parkPanel(target); } }, "–"),
        React.createElement("button", { type: "button", title: "Close", style: styles.windowControl, onClick: (event: React.MouseEvent) => { event.stopPropagation(); if (entry) void closeTerminal(entry); } }, "×"),
      ),
      extra ?? null,
    );
  }

  function renderParkedTile(target: PanelRecord, title: string, index: number): React.JSX.Element {
    const mode = previewPaused ? "paused" : (livePreviews.includes(target.panelId) ? "live" : "static");
    const snapshot = previewSnapshots[target.panelId] || readPanelPreview(target.panelId);
    const subtitle = snapshot ? snapshot.trim().split("\n")[0]?.slice(0, 48) : (mode === "paused" ? "Preview paused · still live" : "Session still live");
    return React.createElement("article", {
      key: target.panelId,
      style: { ...styles.parkedTile, background: parkedColors[index % parkedColors.length] },
      draggable: true,
      "data-panel-id": target.panelId,
      "data-panel-placement": target.placement,
      "data-panel-revision": target.revision,
      onClick: () => setFocusedPanelId(target.panelId),
      onDragStart: (event: React.DragEvent) => startPanelDrag(event, target.panelId),
      onDoubleClick: () => snapBackPanel(target),
      onContextMenu: (event: React.MouseEvent) => { event.preventDefault(); snapBackPanel(target); },
    },
      React.createElement("div", { style: styles.parkedTileTop },
        React.createElement("div", null,
          React.createElement("div", { style: styles.parkedTileTitle }, title),
          React.createElement("div", { style: styles.parkedTileSub }, subtitle),
        ),
        React.createElement("button", { type: "button", title: "Restore", style: styles.parkedRestore, onClick: (event: React.MouseEvent) => { event.stopPropagation(); snapBackPanel(target); } }, "↩"),
      ),
      React.createElement("pre", { style: styles.preview, "data-preview-mode": mode }, snapshot || ""),
      React.createElement("div", { style: styles.parkedHint }, "Double-click to restore"),
    );
  }

  const railItem = (id: "home" | "sessions" | "settings", label: string, glyph: string, onClick: () => void): React.JSX.Element =>
    React.createElement("button", {
      type: "button",
      style: { ...styles.railItem, ...(shellView === id ? styles.railItemActive : {}) },
      "data-rail": id,
      onClick,
    },
      React.createElement("span", { style: styles.railGlyph }, glyph),
      React.createElement("span", null, label),
    );

  const topBar = React.createElement("div", { style: styles.topBar },
    React.createElement("div", { style: styles.wordmark },
      React.createElement("span", { style: styles.wordmarkBox }, "NEXUS"),
      React.createElement("span", { style: styles.wordmarkRest }, "OPERATIONS COCKPIT"),
    ),
    React.createElement("div", { style: styles.headerActions },
      React.createElement("button", { type: "button", style: styles.headerButton, onClick: () => { void launchProfile(shellProfile); } }, "New Terminal"),
      React.createElement("button", { type: "button", style: styles.headerButton, onClick: () => { void launchProfile(claudeProfile); } }, "Claude"),
      React.createElement("button", { type: "button", style: styles.headerButton, onClick: () => { void launchProfile(codexProfile); } }, "Codex"),
      ...(sshInfo?.profiles ?? []).map((profile) => React.createElement("button", {
        key: profile.profileId,
        type: "button",
        style: styles.headerButton,
        onClick: () => { void connectSsh(profile.profileId); },
      }, "SSH: " + profile.name)),
      React.createElement("button", { type: "button", style: styles.headerButtonGhost, onClick: () => { void window.nexusSsh.openFile().then((problem) => { if (problem) setSshError(problem); }); } }, "Edit SSH"),
    ),
    React.createElement("div", { style: styles.statusCluster },
      React.createElement("span", { style: styles.localDot }),
      React.createElement("span", null, "LOCAL"),
      React.createElement("span", { style: styles.clock }, clock),
    ),
  );

  const workspaceHeader = React.createElement("div", { style: styles.workspaceHeader },
    React.createElement("div", { style: styles.workspaceMark }, "▦"),
    React.createElement("div", null,
      React.createElement("h1", { style: styles.title }, workspace.name),
      React.createElement("div", { style: styles.workspaceMeta },
        React.createElement("strong", { style: styles.workspaceMetaLabel }, "Active workspace"),
        React.createElement("span", null, shelf.live.length + " live windows · " + shelf.parked.length + " parked · Windows remain live while parked"),
      ),
    ),
  );

  const liveCanvas = React.createElement("section", { style: styles.liveCanvas, "aria-label": "Live workspace" },
    shelf.live.length === 0
      ? React.createElement("div", { style: styles.emptyState },
        React.createElement("div", { style: styles.muted }, layoutLoaded ? "No live terminals in this workspace. Start one, or restore a parked window." : "Loading workspace…"),
        layoutLoaded ? React.createElement("button", { type: "button", style: styles.headerButton, onClick: () => { void launchProfile(shellProfile); } }, "New Terminal") : null,
      )
      : React.createElement("div", { style: styles.liveGrid },
        shelf.live.map((item) => {
          const entry = visibleTerminals.find((candidate) => candidate.panel.panelId === item.panelId);
          if (!entry) return renderLiveWindow(item, item.panelId);
          return renderLiveWindow(entry.panel, entry.label,
            React.createElement(React.Fragment, null,
              React.createElement(TerminalView, { key: entry.attachmentId, host: window.nexusHost, sessionId: entry.panel.sessionId, attachmentId: entry.attachmentId, initialOutput: entry.output, writable: entry.writable }),
              React.createElement("div", { style: styles.windowFooter },
                React.createElement("button", { onClick: () => dispatch(entry.panel.panelId, { op: "summon", panelId: entry.panel.panelId, targetSurface: "main" }) }, "Summon"),
                React.createElement("button", { onClick: () => dispatch(entry.panel.panelId, { op: "setHome", panelId: entry.panel.panelId, anchor: { ...entry.panel.homeAnchor, layoutRevision: entry.panel.homeAnchor.layoutRevision + 1 } }) }, "Set Home"),
                React.createElement("button", { onClick: () => { void runLifecycle(entry, "interrupt"); } }, "Interrupt"),
                entry.profile ? React.createElement("button", { onClick: () => { void runLifecycle(entry, "restart"); } }, "Restart") : null,
                React.createElement("button", { onClick: () => { void runLifecycle(entry, "terminate"); } }, "Terminate"),
                lifecycleErrors[entry.panel.panelId] ? React.createElement("span", { style: styles.error }, lifecycleErrors[entry.panel.panelId]) : null,
              ),
            ),
          );
        }),
      ),
  );

  const workspaceSwitcher = React.createElement("div", { id: "metro-workspaces", style: styles.workspaceDock },
    React.createElement("div", { style: styles.sectionLabel }, "WORKSPACES"),
    tiles.length === 0
      ? React.createElement("div", { style: { ...styles.workspaceTile, background: tileColors[0] }, "data-current": "true" }, workspace.name)
      : tiles.map((tile, index) => React.createElement("button", {
        key: tile.workspaceId,
        type: "button",
        style: { ...styles.workspaceTile, background: tileColors[index % tileColors.length], outline: tile.current ? "2px solid #ffffff" : "none" },
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
        React.createElement("span", { style: tile.current ? styles.tileStatusActive : styles.tileStatus }, tile.current ? "ACTIVE" : "RUNNING"),
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
  );

  const parkedDock = React.createElement("div", { style: styles.parkedDock },
    React.createElement("div", { style: styles.parkedHeading },
      React.createElement("span", { style: styles.sectionLabel }, "PARKED (" + shelf.parked.length + ")"),
      React.createElement("span", { style: styles.muted }, "Background windows (still live) · Double-click any window to restore it"),
    ),
    shelf.parked.length === 0
      ? React.createElement("div", { style: styles.muted }, "Nothing parked. Parked sessions stay live.")
      : React.createElement("div", { style: styles.parkedRow },
        shelf.parked.map((item, index) => {
          const entry = visibleTerminals.find((candidate) => candidate.panel.panelId === item.panelId);
          return renderParkedTile(item, entry?.label ?? item.panelId, index);
        }),
      ),
  );

  const sessionsView = React.createElement("section", { style: styles.auxView, "aria-label": "Sessions" },
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
  );

  const settingsView = React.createElement("section", { style: styles.auxView, "aria-label": "Settings" },
    React.createElement("div", { style: styles.sectionLabel }, "SETTINGS"),
    React.createElement("p", { style: styles.muted }, "Companion and SSH profile files live in this machine's userData directory. Changes to network settings apply on restart."),
    React.createElement("div", { style: styles.shelfToolbar },
      React.createElement("button", { type: "button", onClick: () => { void window.nexusSsh.openFile().then((problem) => { if (problem) setSshError(problem); }); } }, "Edit SSH profiles"),
      React.createElement("button", { type: "button", onClick: () => { void window.nexusCompanion.openNetworkFile(); } }, "Edit companion network settings"),
    ),
    companionInfo ? React.createElement("div", { style: styles.companionCard },
      React.createElement("div", { style: styles.sectionLabel }, "COMPANION (READ-ONLY, " + (companionInfo.mode === "local" ? "LOOPBACK" : companionInfo.mode === "private" ? "PRIVATE NETWORK" : "HTTPS") + ")"),
      React.createElement("span", { style: styles.muted }, companionInfo.url+" · host "+companionInfo.hostId),
      companionInfo.enrollmentToken
        ? React.createElement(React.Fragment, null,
          React.createElement("div", { style: styles.muted }, "Enrollment token (shown once this run):"),
          React.createElement("code", { style: styles.token }, companionInfo.enrollmentToken),
          React.createElement("button", { onClick: () => { void navigator.clipboard.writeText(companionInfo.enrollmentToken ?? ""); } }, "Copy token"))
        : React.createElement("span", { style: styles.muted }, "Token already shown this run, or the companion is not started."),
      companionInfo.credentialsPath
        ? React.createElement("span", { style: styles.muted }, "Saved (user-only): "+companionInfo.credentialsPath)
        : React.createElement("span", { style: styles.error }, companionInfo.credentialsWarning ?? "No credentials file written."),
      companionInfo.networkWarning ? React.createElement("span", { style: styles.error }, companionInfo.networkWarning) : null,
    ) : React.createElement("div", { style: styles.muted }, "Companion is not running in this session (smoke runs do not start it)."),
    sshError ? React.createElement("span", { style: styles.error }, sshError) : null,
  );

  return React.createElement(
    "div",
    { style: styles.app },
    topBar,
    React.createElement("div", { style: styles.shell },
      React.createElement("nav", { style: styles.rail, "aria-label": "Shell" },
        railItem("home", "Home", "⌂", () => setShellView("home")),
        React.createElement("button", {
          type: "button",
          style: styles.railItem,
          "data-rail": "workspaces",
          onClick: () => {
            setShellView("home");
            window.setTimeout(() => document.getElementById("metro-workspaces")?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 0);
          },
        }, React.createElement("span", { style: styles.railGlyph }, "▦"), React.createElement("span", null, "Workspaces")),
        railItem("sessions", "Sessions", ">_", () => setShellView("sessions")),
        railItem("settings", "Settings", "⚙", () => setShellView("settings")),
      ),
      shellView === "sessions" ? sessionsView
        : shellView === "settings" ? settingsView
        : React.createElement("div", { style: styles.home },
          workspaceHeader,
          liveCanvas,
          React.createElement("div", { style: styles.bottomBand },
            workspaceSwitcher,
            parkedDock,
          ),
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
        React.createElement("div", { style: styles.windowFooter },
          React.createElement("button", { type: "submit" }, "Create"),
          React.createElement("button", { type: "button", onClick: () => setWorkspacePrompt(null) }, "Cancel"),
        ),
      ),
    ) : null,
  );
}

const styles: Record<string, React.CSSProperties> = {
  app: { minHeight: "100vh", boxSizing: "border-box", background: "#07111f", color: "#ffffff", fontFamily: "Segoe UI, Segoe UI Variable, sans-serif", display: "flex", flexDirection: "column" },
  topBar: { display: "flex", alignItems: "center", gap: 16, padding: "10px 16px", background: "#06101c", borderBottom: "1px solid #16304a", flexWrap: "wrap" },
  wordmark: { display: "flex", alignItems: "center", gap: 10, letterSpacing: 1.4, fontWeight: 700, fontSize: 13 },
  wordmarkBox: { background: "#0078D4", color: "#fff", padding: "4px 8px", borderRadius: 4, letterSpacing: 1.6 },
  wordmarkRest: { opacity: 0.9, fontWeight: 600 },
  headerActions: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginLeft: "auto" },
  headerButton: { border: "none", background: "#0078D4", color: "#fff", padding: "7px 12px", cursor: "pointer", fontWeight: 600, borderRadius: 2 },
  headerButtonGhost: { border: "1px solid #3a5675", background: "transparent", color: "#fff", padding: "7px 12px", cursor: "pointer", fontWeight: 600 },
  statusCluster: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, letterSpacing: 1, fontWeight: 600 },
  localDot: { width: 8, height: 8, borderRadius: 99, background: "#3DDB84", display: "inline-block" },
  clock: { opacity: 0.9, marginLeft: 8, paddingLeft: 8, borderLeft: "1px solid #3a5675" },
  shell: { display: "grid", gridTemplateColumns: "88px 1fr", flex: 1, minHeight: 0 },
  rail: { background: "#050d18", borderRight: "1px solid #16304a", display: "flex", flexDirection: "column", padding: "12px 8px", gap: 8 },
  railItem: { border: "none", background: "transparent", color: "#c5d4e6", padding: "12px 6px", cursor: "pointer", display: "grid", gap: 6, justifyItems: "center", fontSize: 10, letterSpacing: 0.8, textTransform: "uppercase", fontWeight: 700 },
  railItemActive: { background: "#0078D4", color: "#fff" },
  railGlyph: { fontSize: 20, lineHeight: 1 },
  home: { display: "grid", gridTemplateRows: "auto 1fr auto", minHeight: 0, padding: "16px 20px 20px", gap: 14 },
  workspaceHeader: { display: "flex", alignItems: "center", gap: 14 },
  workspaceMark: { width: 44, height: 44, background: "#12324d", display: "grid", placeItems: "center", fontSize: 22 },
  title: { margin: 0, fontSize: 32, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase" },
  workspaceMeta: { display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap", color: "#9db0c6", fontSize: 13, marginTop: 4 },
  workspaceMetaLabel: { color: "#fff", fontWeight: 600, fontSize: 13 },
  liveCanvas: { minHeight: 280 },
  liveGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 12, alignContent: "start" },
  liveWindow: { background: "#0b1624", color: "#fff", overflow: "hidden", display: "flex", flexDirection: "column", border: "1px solid #1d3650", minHeight: 280 },
  windowTitleBar: { display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "#102033", borderBottom: "1px solid #1d3650" },
  windowGlyph: { color: "#7dd0ff", fontFamily: "Cascadia Code, Consolas, monospace", fontSize: 13 },
  windowTitle: { fontSize: 13, fontWeight: 650, letterSpacing: 0.2 },
  runningPill: { color: "#04130a", background: "#3DDB84", fontSize: 10, fontWeight: 800, letterSpacing: 0.8, padding: "2px 7px", borderRadius: 99 },
  windowSpacer: { flex: 1 },
  windowControl: { border: "none", background: "transparent", color: "#c5d4e6", width: 24, height: 22, cursor: "pointer", fontSize: 14 },
  windowFooter: { display: "flex", gap: 8, padding: "8px 10px", flexWrap: "wrap", background: "#08121d", borderTop: "1px solid #1d3650" },
  emptyState: { display: "grid", gap: 12, padding: 28, background: "#0b1624", border: "1px dashed #3a5675", alignContent: "center", justifyItems: "start", minHeight: 220 },
  bottomBand: { display: "grid", gridTemplateColumns: "240px 1fr", gap: 16, alignItems: "start" },
  workspaceDock: { display: "grid", gap: 8, alignContent: "start" },
  workspaceTile: { border: "none", color: "#fff", minHeight: 64, padding: "10px 12px", textAlign: "left", cursor: "pointer", display: "grid", gridTemplateColumns: "1fr auto", gridTemplateRows: "auto auto", columnGap: 8, alignContent: "space-between" },
  newWorkspaceTile: { border: "1px dashed #5a7a98", color: "#fff", background: "transparent", minHeight: 64, padding: "10px 12px", textAlign: "left", cursor: "pointer", display: "grid", alignContent: "space-between" },
  workspaceTileName: { fontSize: 16, fontWeight: 700, gridColumn: "1 / 2" },
  workspaceTileMeta: { fontSize: 11, opacity: 0.9, gridColumn: "1 / 2" },
  tileStatus: { fontSize: 10, fontWeight: 800, letterSpacing: 0.8, alignSelf: "center", gridColumn: "2", gridRow: "1 / span 2" },
  tileStatusActive: { fontSize: 10, fontWeight: 800, letterSpacing: 0.8, alignSelf: "center", gridColumn: "2", gridRow: "1 / span 2", color: "#04130a", background: "#3DDB84", padding: "3px 7px", borderRadius: 99 },
  parkedDock: { display: "grid", gap: 8, minWidth: 0 },
  parkedHeading: { display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" },
  parkedRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 },
  parkedTile: { color: "#fff", overflow: "hidden", display: "flex", flexDirection: "column", cursor: "pointer", minHeight: 150, padding: 12, boxSizing: "border-box" },
  parkedTileTop: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  parkedTileTitle: { fontSize: 16, fontWeight: 700 },
  parkedTileSub: { fontSize: 12, opacity: 0.9, marginTop: 4 },
  parkedRestore: { border: "none", background: "rgba(0,0,0,0.25)", color: "#fff", width: 32, height: 32, cursor: "pointer", fontSize: 16 },
  parkedHint: { marginTop: "auto", paddingTop: 8, fontSize: 12, opacity: 0.9 },
  preview: { margin: "8px 0 0", minHeight: 36, maxHeight: 48, overflow: "hidden", padding: 0, color: "rgba(255,255,255,0.85)", background: "transparent", fontFamily: "Cascadia Code, Consolas, monospace", fontSize: 11, lineHeight: 1.3, pointerEvents: "none", whiteSpace: "pre-wrap", wordBreak: "break-word" },
  auxView: { padding: 24, display: "grid", alignContent: "start", gap: 12 },
  shelfToolbar: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" },
  sectionLabel: { color: "#ffffff", fontSize: 11, letterSpacing: 2, fontWeight: 700, margin: 0, opacity: 0.8 },
  sessionCard: { display: "grid", gap: 6, padding: 12, background: "#0b1624", border: "1px solid #1d3650" },
  muted: { color: "#9db0c6", fontSize: 12 },
  running: { color: "#3DDB84", fontSize: 12 },
  error: { color: "#ff8a80", fontSize: 12 },
  companionCard: { display: "grid", gap: 8, marginTop: 8, padding: 12, background: "#0b1624", border: "1px solid #1d3650", wordBreak: "break-all" },
  token: { padding: 8, background: "#07111f", color: "#a6ef3a", fontFamily: "Cascadia Code, Consolas, monospace", fontSize: 12 },
  modalBackdrop: { position: "fixed", inset: 0, background: "#00000099", display: "grid", placeItems: "center", zIndex: 20 },
  modal: { background: "#0b1624", padding: 24, minWidth: 320, display: "grid", gap: 12, border: "1px solid #3a5675" },
  modalInput: { padding: "8px 10px", fontSize: 16, background: "#07111f", color: "#fff", border: "1px solid #3a5675" },
};

createRoot(document.getElementById("root")!).render(React.createElement(App));
