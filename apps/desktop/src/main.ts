import { app, BrowserWindow, Menu, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PtySupervisor, type AttachmentMode, type PtyAttachment } from "@nexus/host-agent/supervisor";
import { parseSshProfileFile, resolveSshProfile } from "@nexus/host-agent/ssh-profile";
import { MetadataStore } from "@nexus/storage/metadata";
import { assertNonSecretCliArguments, type CliProfileRecord, type PanelRecord, type WorkspaceRecord } from "@nexus/contracts";
import { exportRedactedLayout, importRedactedLayout } from "@nexus/core/layout";
import { parsePreviewConcurrency, parsePreviewIntervalMs } from "@nexus/core/metro-preview";
import { isLabOrDemoPanel, sessionsToClearExited, sessionsToClearLab } from "@nexus/core/session-shelf";
import { runGitInspect } from "./git-inspect.js";
import { startCompanionService, type CompanionService } from "@nexus/integration/companion-service";
import { parseCompanionNetworkConfig, type CompanionNetworkConfig } from "@nexus/integration/companion-network";
import { createMetadataReadModel } from "@nexus/integration/metadata-read-model";
import { createSupervisorOutputSource } from "@nexus/integration/supervisor-output-source";

const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);
const rendererPath = path.resolve(currentDirectory, "../renderer/index.html");
const rendererUrl = pathToFileURL(rendererPath).toString();

/** Smoke and tests must not write into the operator's real userData database. */
if (process.env.NEXUS_DESKTOP_USER_DATA) {
  fs.mkdirSync(process.env.NEXUS_DESKTOP_USER_DATA, { recursive: true });
  app.setPath("userData", path.resolve(process.env.NEXUS_DESKTOP_USER_DATA));
}

let hostSupervisor: PtySupervisor;
let metadataStore: MetadataStore;
let companion: CompanionService | null = null;
let companionTokenRevealed = false;
let companionNetworkWarning: string | null = null;

/** Runtime identity only; never a committed machine name. */
function runtimeHostIdentity(hostname = os.hostname()): { hostId: string; displayName: string } {
  const displayName = hostname.trim() || "Local host";
  const hostId = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "local-host";
  return { hostId, displayName };
}

const companionHost = runtimeHostIdentity();
const companionHostId = companionHost.hostId;
const demoSessionId = "desktop-demo-session";
const attachments = new Map<string, { sessionId: string; owner: WebContents; handle: PtyAttachment }>();
const writerBySession = new Map<string, string>();

function assertRenderer(event: IpcMainInvokeEvent): void {
  if (!event.senderFrame || event.senderFrame.url !== rendererUrl) {
    throw new Error(`unauthorized renderer origin: ${event.senderFrame?.url ?? "none"}`);
  }
}

function assertSessionId(sessionId: unknown): asserts sessionId is string {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("invalid session ID");
  }
}

function isPanelRecord(value: unknown): value is PanelRecord {
  if (typeof value !== "object" || value === null) return false;
  const panel = value as Partial<PanelRecord>;
  const anchor = panel.homeAnchor;
  return typeof panel.panelId === "string" && typeof panel.sessionId === "string" &&
    typeof panel.workspaceId === "string" && Number.isInteger(panel.revision) &&
    ["docked", "focused", "floating", "detached", "parked"].includes(panel.placement ?? "") &&
    typeof anchor === "object" && anchor !== null && typeof anchor.workspaceId === "string" &&
    typeof anchor.groupId === "string" && Array.isArray(anchor.splitPath) &&
    anchor.splitPath.every((part) => typeof part === "string") && Number.isInteger(anchor.tabIndex) &&
    ["center", "left", "right", "top", "bottom"].includes(anchor.fallbackZone ?? "") &&
    Number.isInteger(anchor.layoutRevision);
}

function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
  if (typeof value !== "object" || value === null) return false;
  const workspace = value as Partial<WorkspaceRecord>;
  return typeof workspace.workspaceId === "string" && workspace.workspaceId.length > 0 &&
    typeof workspace.name === "string" && workspace.name.trim().length > 0 &&
    typeof workspace.createdAt === "string" && typeof workspace.lastOpenedAt === "string";
}

function isCliProfileRecord(value: unknown): value is CliProfileRecord {
  if (typeof value !== "object" || value === null) return false;
  const profile = value as Partial<CliProfileRecord>;
  return typeof profile.profileId === "string" && profile.profileId.length > 0 &&
    typeof profile.name === "string" && profile.name.trim().length > 0 &&
    (profile.executable === "claude" || profile.executable === "codex" || profile.executable === "shell") &&
    Array.isArray(profile.args) && profile.args.every((arg) => typeof arg === "string") &&
    (profile.cwd === undefined || typeof profile.cwd === "string") &&
    (() => { try { assertNonSecretCliArguments(profile.args); return true; } catch { return false; } })();
}


function metroPreviewConfig(): { intervalMs: number; maxConcurrent: number; trace: boolean } {
  return {
    intervalMs: parsePreviewIntervalMs(process.env.NEXUS_METRO_PREVIEW_INTERVAL_MS),
    maxConcurrent: parsePreviewConcurrency(process.env.NEXUS_METRO_PREVIEW_CONCURRENCY),
    trace: process.env.NEXUS_METRO_PREVIEW_TRACE === "1",
  };
}

function installApplicationMenu(window: BrowserWindow): void {
  const fileSubmenu: Electron.MenuItemConstructorOptions[] = [
    {
      label: "New Workspace...",
      accelerator: "CmdOrCtrl+Shift+N",
      click: () => {
        if (!window.isDestroyed()) window.webContents.send("nexus:workspace:new");
      },
    },
    { type: "separator" },
    process.platform === "darwin" ? { role: "close" } : { role: "quit" },
  ];
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: "File", submenu: fileSubmenu },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  if (process.platform === "darwin") {
    template.unshift({ label: app.name, submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }] });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function publishWindowVisibility(window: BrowserWindow): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  const hidden = window.isMinimized() || !window.isVisible();
  window.webContents.send("nexus:window:visibility", { hidden });
}

function detachOwner(owner: WebContents): void {
  for (const [attachmentId, attachment] of attachments) {
    if (attachment.owner === owner) {
      attachment.handle.detach();
      attachments.delete(attachmentId);
      if (writerBySession.get(attachment.sessionId) === attachmentId) writerBySession.delete(attachment.sessionId);
    }
  }
}

function detachSessionAttachments(sessionId: string): void {
  for (const [attachmentId, attachment] of attachments) {
    if (attachment.sessionId === sessionId) {
      attachment.handle.detach();
      attachments.delete(attachmentId);
      if (writerBySession.get(sessionId) === attachmentId) writerBySession.delete(sessionId);
    }
  }
}


function allowedGitRoots(): string[] {
  const roots = new Set<string>([process.cwd()]);
  for (const session of metadataStore.listSessions()) {
    if (session.cwd) roots.add(session.cwd);
  }
  for (const profile of metadataStore.listProfiles()) {
    if (profile.cwd) roots.add(profile.cwd);
  }
  return [...roots];
}

function registerGitIpc(): void {
  ipcMain.handle("nexus:git:inspect", async (event, request: unknown) => {
    assertRenderer(event);
    const input = typeof request === "object" && request !== null ? request as { cwd?: unknown; relativeDir?: unknown } : {};
    const payload: { cwd?: unknown; relativeDir?: unknown } = {};
    if (typeof input.cwd === "string") payload.cwd = input.cwd;
    if (typeof input.relativeDir === "string") payload.relativeDir = input.relativeDir;
    return runGitInspect(payload, allowedGitRoots());
  });
}

/** The raw token is revealed to the renderer once per run; the user-only file remains the durable copy. */
function registerCompanionIpc(): void {
  ipcMain.handle("nexus:companion:info", (event) => {
    assertRenderer(event);
    if (!companion) return null;
    const { mode, url, hostId, enrollmentToken, credentialsPath, credentialsWarning } = companion.info;
    const reveal = !companionTokenRevealed;
    companionTokenRevealed = true;
    return { mode, url, hostId, credentialsPath, credentialsWarning, networkWarning: companionNetworkWarning, ...(reveal ? { enrollmentToken } : {}) };
  });
  ipcMain.handle("nexus:companion:open-network-file", async (event) => {
    assertRenderer(event);
    loadCompanionNetwork(); // creates the file on first use
    const problem = await shell.openPath(companionNetworkPath());
    return problem === "" ? null : problem;
  });
}

/**
 * How the companion is reachable is chosen in a user-editable file (default {"mode":"local"}). A missing,
 * invalid or unstartable remote configuration falls back to loopback-only and says why, so a typo can
 * never widen exposure.
 */
function companionNetworkPath(): string {
  return path.join(app.getPath("userData"), "companion-network.json");
}

function loadCompanionNetwork(): { config: CompanionNetworkConfig; warning: string | null } {
  const file = companionNetworkPath();
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ mode: "local" }) + "\n", { flag: "wx" });
    if (fs.statSync(file).size > 16 * 1024) return { config: { mode: "local" }, warning: "companion-network.json is too large; using local mode" };
    const parsed = parseCompanionNetworkConfig(fs.readFileSync(file, "utf8"));
    return parsed.config ? { config: parsed.config, warning: null } : { config: { mode: "local" }, warning: "companion-network.json: " + parsed.error + "; using local mode" };
  } catch (error) {
    return { config: { mode: "local" }, warning: "cannot read companion-network.json: " + (error instanceof Error ? error.message : String(error)) + "; using local mode" };
  }
}

/**
 * SSH profiles live in a user-editable JSON file. The renderer only ever sends a profile ID: the argv is
 * built here from the validated file contents, so a compromised renderer cannot inject ssh options.
 */
function sshProfilesPath(): string {
  return path.join(app.getPath("userData"), "ssh-profiles.json");
}

function loadSshProfiles(): ReturnType<typeof parseSshProfileFile> {
  const file = sshProfilesPath();
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, "[]\n", { flag: "wx" });
    if (fs.statSync(file).size > 256 * 1024) return { profiles: [], errors: ["profiles file is larger than 256 KB"] };
    return parseSshProfileFile(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { profiles: [], errors: [`cannot read profiles file: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function registerSshIpc(): void {
  ipcMain.handle("nexus:ssh:list", (event) => {
    assertRenderer(event);
    const { profiles, errors } = loadSshProfiles();
    return {
      path: sshProfilesPath(),
      errors,
      profiles: profiles.map(({ profileId, name, host, user, port, remoteTmuxSession }) => ({
        profileId, name, host,
        ...(user === undefined ? {} : { user }),
        ...(port === undefined ? {} : { port }),
        ...(remoteTmuxSession === undefined ? {} : { remoteTmuxSession }),
      })),
    };
  });
  ipcMain.handle("nexus:ssh:start", (event, profileId: unknown) => {
    assertRenderer(event);
    if (typeof profileId !== "string") throw new Error("invalid SSH profile request");
    const profile = loadSshProfiles().profiles.find((candidate) => candidate.profileId === profileId);
    if (!profile) throw new Error("unknown SSH profile");
    const resolved = resolveSshProfile(profile);
    const session = hostSupervisor.start(resolved.file, resolved.args, { sessionId: crypto.randomUUID() });
    rememberSessionLabel(session.sessionId, profile.name);
    return { ...session, name: profile.name };
  });
  ipcMain.handle("nexus:ssh:open-file", async (event) => {
    assertRenderer(event);
    loadSshProfiles(); // creates the file on first use
    const problem = await shell.openPath(sshProfilesPath());
    return problem === "" ? null : problem;
  });
}


function rememberSessionLabel(sessionId: string, label: string, cwd?: string): void {
  const current = metadataStore.loadSession(sessionId);
  if (!current) return;
  metadataStore.saveSession({
    ...current,
    label,
    ...(cwd === undefined ? {} : { cwd }),
  });
}

function isSupervisorRunning(sessionId: string): boolean {
  try {
    return hostSupervisor.snapshot(sessionId).status === "running";
  } catch {
    return false;
  }
}

function deletePersistedSessions(sessionIds: readonly string[], terminateLab: boolean): number {
  const removable: string[] = [];
  for (const sessionId of sessionIds) {
    if (isSupervisorRunning(sessionId)) {
      if (!terminateLab) continue;
      detachSessionAttachments(sessionId);
      void hostSupervisor.terminate(sessionId).catch(() => undefined);
      try { hostSupervisor.dispose(sessionId); } catch { /* already gone */ }
    }
    removable.push(sessionId);
  }
  return removable.length === 0 ? 0 : metadataStore.deleteSessions(removable);
}

function registerHostIpc(): void {
  ipcMain.handle("nexus:host:start-demo", (event) => {
    assertRenderer(event);
    try {
      return hostSupervisor.snapshot(demoSessionId);
    } catch {
      const shell = process.env.ComSpec ?? "cmd.exe";
      return hostSupervisor.start(shell, ["/d", "/c", "node", "-e", "let n=0; setInterval(() => console.log('ipc-tick-'+(++n)), 250); setTimeout(() => process.exit(0), 5000);"], {
        sessionId: demoSessionId,
      });
    }
  });
  ipcMain.handle("nexus:host:start-profile", (event, profile: unknown, requestedSessionId: unknown = crypto.randomUUID()) => {
    assertRenderer(event);
    if (!isCliProfileRecord(profile) || typeof requestedSessionId !== "string" || requestedSessionId.length === 0) {
      throw new Error("invalid CLI profile request");
    }
    const session = hostSupervisor.startProfile(profile, { sessionId: requestedSessionId });
    metadataStore.saveProfile(profile);
    rememberSessionLabel(session.sessionId, profile.name, profile.cwd);
    return session;
  });
  ipcMain.handle("nexus:host:interrupt", async (event, sessionId: unknown) => {
    assertRenderer(event);
    assertSessionId(sessionId);
    return hostSupervisor.interrupt(sessionId);
  });
  ipcMain.handle("nexus:host:restart-profile", async (event, sessionId: unknown, profile: unknown) => {
    assertRenderer(event);
    assertSessionId(sessionId);
    if (!isCliProfileRecord(profile)) throw new Error("invalid CLI profile request");
    const session = await hostSupervisor.restartProfile(sessionId, profile);
    metadataStore.saveProfile(profile);
    rememberSessionLabel(session.sessionId, profile.name, profile.cwd);
    return session;
  });
  ipcMain.handle("nexus:host:terminate", async (event, sessionId: unknown, confirmationToken: unknown) => {
    assertRenderer(event);
    assertSessionId(sessionId);
    if (confirmationToken !== `terminate:${sessionId}`) throw new Error("termination confirmation required");
    detachSessionAttachments(sessionId);
    const result = await hostSupervisor.terminate(sessionId);
    hostSupervisor.dispose(sessionId);
    return result.session;
  });
  ipcMain.handle("nexus:host:status", (event, sessionId: unknown) => {
    assertRenderer(event);
    assertSessionId(sessionId);
    return hostSupervisor.snapshot(sessionId);
  });
  ipcMain.handle("nexus:host:attach", (event, sessionId: unknown, requestedMode: unknown = "read") => {
    assertRenderer(event);
    assertSessionId(sessionId);
    if (requestedMode !== "read" && requestedMode !== "write") throw new Error("invalid attachment mode");
    const mode = requestedMode as AttachmentMode;
    if (mode === "write" && writerBySession.has(sessionId)) throw new Error("session already has a writer");
    const attachmentId = crypto.randomUUID();
    const handle = hostSupervisor.attach(sessionId, mode);
    handle.onData((data) => {
      if (!event.sender.isDestroyed()) event.sender.send("nexus:host:data", { attachmentId, data });
    });
    attachments.set(attachmentId, { sessionId, owner: event.sender, handle });
    if (mode === "write") writerBySession.set(sessionId, attachmentId);
    return { attachmentId, replay: handle.replay };
  });
  ipcMain.handle("nexus:host:detach", (event, attachmentId: unknown) => {
    assertRenderer(event);
    if (typeof attachmentId !== "string") throw new Error("invalid attachment ID");
    const attachment = attachments.get(attachmentId);
    if (!attachment || attachment.owner !== event.sender) throw new Error("unknown attachment");
    attachment.handle.detach();
    attachments.delete(attachmentId);
    if (writerBySession.get(attachment.sessionId) === attachmentId) writerBySession.delete(attachment.sessionId);
  });
  ipcMain.handle("nexus:host:resize", (event, attachmentId: unknown, cols: unknown, rows: unknown) => {
    assertRenderer(event);
    if (typeof attachmentId !== "string" || typeof cols !== "number" || typeof rows !== "number") throw new Error("invalid terminal size");
    const attachment = attachments.get(attachmentId);
    if (!attachment || attachment.owner !== event.sender) throw new Error("unknown attachment");
    if (attachment.handle.mode !== "write") throw new Error("read attachment cannot resize");
    hostSupervisor.resize(attachment.sessionId, cols, rows);
  });
  ipcMain.handle("nexus:host:write", (event, attachmentId: unknown, data: unknown) => {
    assertRenderer(event);
    if (typeof attachmentId !== "string" || typeof data !== "string") throw new Error("invalid write request");
    if (data.length > 4096 || data.includes("\u0000")) throw new Error("invalid terminal input");
    const attachment = attachments.get(attachmentId);
    if (!attachment || attachment.owner !== event.sender) throw new Error("unknown attachment");
    attachment.handle.write(data);
  });
  ipcMain.handle("nexus:layout:save", (event, panels: unknown) => {
    assertRenderer(event);
    if (!Array.isArray(panels) || !panels.every(isPanelRecord)) throw new Error("invalid layout metadata");
    metadataStore.savePanels(panels);
  });
  ipcMain.handle("nexus:layout:load", (event, panelId: unknown) => {
    assertRenderer(event);
    if (typeof panelId !== "string" || panelId.length === 0) throw new Error("invalid panel ID");
    return metadataStore.loadPanel(panelId);
  });
  ipcMain.handle("nexus:layout:list", (event, workspaceId: unknown) => {
    assertRenderer(event);
    if (typeof workspaceId !== "string" || workspaceId.length === 0) throw new Error("invalid workspace ID");
    return metadataStore.listPanels(workspaceId);
  });
  ipcMain.handle("nexus:layout:export", (event, workspaceId: unknown) => {
    assertRenderer(event);
    if (typeof workspaceId !== "string" || workspaceId.length === 0) throw new Error("invalid workspace ID");
    return exportRedactedLayout(metadataStore.listPanels(workspaceId));
  });
  ipcMain.handle("nexus:layout:import", (event, serialized: unknown) => {
    assertRenderer(event);
    if (typeof serialized !== "string" || serialized.length > 256 * 1024) throw new Error("invalid layout import");
    return importRedactedLayout(serialized);
  });
  ipcMain.handle("nexus:workspace:list", (event) => {
    assertRenderer(event);
    return metadataStore.listWorkspaces();
  });
  ipcMain.handle("nexus:workspace:save", (event, workspace: unknown) => {
    assertRenderer(event);
    if (!isWorkspaceRecord(workspace)) throw new Error("invalid workspace metadata");
    metadataStore.saveWorkspace(workspace);
  });
  ipcMain.handle("nexus:metro:preview-config", (event) => {
    assertRenderer(event);
    return metroPreviewConfig();
  });
  ipcMain.handle("nexus:session:list", (event) => {
    assertRenderer(event);
    return metadataStore.listSessions();
  });
  ipcMain.handle("nexus:session:clear-exited", (event) => {
    assertRenderer(event);
    deletePersistedSessions(sessionsToClearExited(metadataStore.listSessions()), false);
    return metadataStore.listSessions();
  });
  ipcMain.handle("nexus:session:clear-lab", (event) => {
    assertRenderer(event);
    for (const workspace of metadataStore.listWorkspaces()) {
      for (const panel of metadataStore.listPanels(workspace.workspaceId)) {
        if (isLabOrDemoPanel(panel.panelId)) metadataStore.deletePanel(panel.panelId);
      }
    }
    deletePersistedSessions(sessionsToClearLab(metadataStore.listSessions()), true);
    return metadataStore.listSessions();
  });
}

async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b1020",
    webPreferences: {
      preload: path.join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("console-message", (_event, _level, message, line, source) => {
    console.log(`[renderer ${source}:${line}] ${message}`);
  });
  window.webContents.on("destroyed", () => detachOwner(window.webContents));
  // A reload keeps the same WebContents, so without this the old page would keep the writer lock and every
  // recovered terminal would silently come back read-only.
  window.webContents.on("did-start-loading", () => detachOwner(window.webContents));
  window.webContents.on("render-process-gone", () => detachOwner(window.webContents));
  installApplicationMenu(window);
  const publish = (): void => publishWindowVisibility(window);
  window.on("minimize", publish);
  window.on("restore", publish);
  window.on("hide", publish);
  window.on("show", publish);
  window.webContents.on("did-finish-load", publish);
  await window.loadFile(rendererPath);
  return window;
}

async function runReloadSmoke(window: BrowserWindow): Promise<void> {
  const evaluate = async <T>(label: string, script: string): Promise<T> => {
    try {
      return await window.webContents.executeJavaScript(script, true) as T;
    } catch (error) {
      throw new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const bridgeType = await evaluate<string>("bridge probe", "typeof window.nexusHost?.startDemoSession");
  if (bridgeType !== "function") throw new Error(`host bridge unavailable: ${bridgeType}`);
  const first = await evaluate<{ sessionId: string; pid: number }>("initial start", "window.nexusHost.startDemoSession()");
  const firstAttachment = await evaluate<{ attachmentId: string; replay: string }>("initial attach", "window.nexusHost.attach('desktop-demo-session')");
  if (first.sessionId !== demoSessionId || first.pid <= 0) throw new Error("initial host session did not start");
  const readOnlyWrite = await evaluate<string>("read-only input authorization", `window.nexusHost.write('${firstAttachment.attachmentId}', 'blocked').then(() => 'accepted').catch((error) => error.message)`);
  if (!readOnlyWrite.includes("read attachment cannot write")) throw new Error(`read-only attachment accepted input: ${readOnlyWrite}`);
  const layoutSessionId = `desktop-layout-smoke-${Date.now()}`;
  const layoutPanelId = "layout-smoke-panel";
  const layoutProfile = {
    profileId: "desktop-layout-smoke",
    name: "Desktop layout smoke",
    executable: "shell",
    args: ["/d", "/c", "node", "-e", "setInterval(() => {}, 1000)"],
  };
  const layoutStarted = await evaluate<{ sessionId: string }>("layout profile start", `window.nexusHost.startProfile(${JSON.stringify(layoutProfile)}, '${layoutSessionId}')`);
  if (layoutStarted.sessionId !== layoutSessionId) throw new Error("layout profile changed the stable session identity");
  await evaluate<void>("save layout metadata", `window.nexusLayout.save([{
    panelId: '${layoutPanelId}', sessionId: '${layoutSessionId}', workspaceId: 'default',
    placement: 'parked', revision: 2,
    homeAnchor: { workspaceId: 'default', groupId: 'terminals', splitPath: ['root', 'center'],
      tabIndex: 0, fallbackZone: 'center', layoutRevision: 1 }
  }])`);
  const exportedLayout = await evaluate<string>("export redacted layout", "window.nexusLayout.export('default')");
  if (exportedLayout.includes(layoutSessionId) || exportedLayout.includes(demoSessionId) || exportedLayout.includes("windowId") || exportedLayout.includes("surfaceId")) {
    throw new Error("layout export contained runtime or session identity");
  }
  const importedLayout = await evaluate<unknown[]>("import redacted layout", `window.nexusLayout.import(${JSON.stringify(exportedLayout)})`);
  if (!Array.isArray(importedLayout) || importedLayout.length === 0) throw new Error("layout import returned no panels");
  await new Promise((resolve) => setTimeout(resolve, 700));
  const firstReplay = await evaluate<{ attachmentId: string; replay: string }>("initial replay", "window.nexusHost.attach('desktop-demo-session')");
  if (!firstReplay.replay.includes("ipc-tick-")) throw new Error("initial replay was empty");
  await evaluate<void>("detach initial attachment", `window.nexusHost.detach('${firstAttachment.attachmentId}')`);
  await evaluate<void>("detach replay attachment", `window.nexusHost.detach('${firstReplay.attachmentId}')`);
  await window.webContents.reload();
  await new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()));
  const second = await evaluate<{ sessionId: string; pid: number }>("reloaded start", "window.nexusHost.startDemoSession()");
  const secondAttachment = await evaluate<{ attachmentId: string; replay: string }>("reloaded attach", "window.nexusHost.attach('desktop-demo-session')");
  if (second.sessionId !== first.sessionId || second.pid !== first.pid) {
    throw new Error("renderer reload created a duplicate host session");
  }
  if (!secondAttachment.replay.includes("ipc-tick-")) throw new Error("reloaded renderer did not recover replay");
  let renderedPanel: { placement: string; revision: number } | null = null;
  for (let attempt = 0; attempt < 30 && renderedPanel === null; attempt += 1) {
    renderedPanel = await evaluate<{ placement: string; revision: number } | null>("inspect restored layout", `(() => {
      const panel = document.querySelector('[data-panel-id="${layoutPanelId}"]');
      return panel ? { placement: panel.getAttribute('data-panel-placement'), revision: Number(panel.getAttribute('data-panel-revision')) } : null;
    })()`);
    if (renderedPanel === null) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const persistedPanel = await evaluate<{ placement: string; revision: number } | null>("verify persisted layout", `window.nexusLayout.load('${layoutPanelId}')`);
  if (renderedPanel?.placement !== "parked" || renderedPanel.revision !== 2) {
    const body = await evaluate<string>("inspect rendered body", "document.body.innerHTML.slice(0, 2000)");
    throw new Error(`renderer reload did not recover persisted layout metadata: rendered=${JSON.stringify(renderedPanel)} persisted=${JSON.stringify(persistedPanel)} body=${JSON.stringify(body)}`);
  }
  await evaluate<void>("detach reloaded attachment", `window.nexusHost.detach('${secondAttachment.attachmentId}')`);
  const lifecycleSessionId = `desktop-profile-smoke-${Date.now()}`;
  const lifecycleProfile = {
    profileId: "desktop-profile-smoke",
    name: "Desktop lifecycle smoke",
    executable: "shell",
    args: ["/d", "/c", "node", "-e", "setInterval(() => console.log('profile-loop'), 25)"],
  };
  const lifecycleStarted = await evaluate<{ sessionId: string }>("profile start", `window.nexusHost.startProfile(${JSON.stringify(lifecycleProfile)}, '${lifecycleSessionId}')`);
  const lifecycleAttachment = await evaluate<{ attachmentId: string }>("profile attach", `window.nexusHost.attach('${lifecycleSessionId}')`);
  await evaluate<unknown>("profile interrupt", `window.nexusHost.interrupt('${lifecycleSessionId}')`);
  await evaluate<void>("detach before profile restart", `window.nexusHost.detach('${lifecycleAttachment.attachmentId}')`);
  const restartedProfile = { ...lifecycleProfile, args: ["/d", "/c", "echo", "restart-ok"] };
  const lifecycleRestarted = await evaluate<{ sessionId: string }>("profile restart", `window.nexusHost.restartProfile('${lifecycleSessionId}', ${JSON.stringify(restartedProfile)})`);
  if (lifecycleStarted.sessionId !== lifecycleSessionId || lifecycleRestarted.sessionId !== lifecycleSessionId) {
    throw new Error("profile lifecycle changed the stable session identity");
  }
  let restartedAttachment = await evaluate<{ attachmentId: string; replay: string }>("profile replay after restart", `window.nexusHost.attach('${lifecycleSessionId}')`);
  for (let attempt = 0; attempt < 10 && !restartedAttachment.replay.includes("restart-ok"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await evaluate<void>("detach replacement replay probe", `window.nexusHost.detach('${restartedAttachment.attachmentId}')`);
    restartedAttachment = await evaluate<{ attachmentId: string; replay: string }>("retry profile replay after restart", `window.nexusHost.attach('${lifecycleSessionId}')`);
  }
  if (!restartedAttachment.replay.includes("restart-ok")) throw new Error("profile restart replay was not recoverable");
  await evaluate<void>("detach profile attachments", `window.nexusHost.detach('${restartedAttachment.attachmentId}')`);
  await evaluate<unknown>("profile terminate", `window.nexusHost.terminate('${lifecycleSessionId}', 'terminate:${lifecycleSessionId}')`);
  await evaluate<unknown>("layout profile terminate", `window.nexusHost.terminate('${layoutSessionId}', 'terminate:${layoutSessionId}')`).catch(() => undefined);
  console.log("NEXUS reload smoke passed", { sessionId: second.sessionId, pid: second.pid, layoutSessionId });
}

async function runRecoverySmoke(mode: "seed" | "relaunch"): Promise<void> {
  if (mode === "seed") {
    const shell = process.env.ComSpec ?? "cmd.exe";
    const session = hostSupervisor.start(shell, ["/d", "/c", "node", "-e", "setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 15000)"], {
      sessionId: demoSessionId,
    });
    console.log("NEXUS recovery seed passed", { sessionId: session.sessionId, pid: session.pid });
    return;
  }
  const prior = metadataStore.loadSession(demoSessionId);
  if (!prior || prior.process !== "unknown" || prior.recovery !== "relaunch-only") {
    throw new Error(`prior supervisor state was not reconciled: ${JSON.stringify(prior)}`);
  }
  const shell = process.env.ComSpec ?? "cmd.exe";
  const relaunched = hostSupervisor.start(shell, ["/d", "/c", "node", "-e", "setTimeout(() => process.exit(0), 250)"], {
    sessionId: demoSessionId,
  });
  if (relaunched.pid === prior.pid) throw new Error("relaunch reused the prior PTY PID unexpectedly");
  await hostSupervisor.waitForExit(relaunched.sessionId);
  hostSupervisor.dispose(relaunched.sessionId);
  console.log("NEXUS recovery relaunch passed", {
    sessionId: relaunched.sessionId,
    priorPid: prior.pid,
    relaunchedPid: relaunched.pid,
  });
}

function finishSmoke(window: BrowserWindow, code: number): never {
  if (!window.webContents.isDestroyed()) detachOwner(window.webContents);
  process.exit(code);
}

app.whenReady().then(async () => {
  const hostBootEpoch = `desktop-${process.pid}-${Date.now()}`;
  metadataStore = new MetadataStore(path.join(app.getPath("userData"), "nexus.sqlite"));
  metadataStore.reconcileSupervisorRestart(hostBootEpoch);
  hostSupervisor = new PtySupervisor({
    maxOutputBytes: 64 * 1024,
    metadata: metadataStore,
    hostId: companionHostId,
    hostBootEpoch,
  });
  registerHostIpc();
  registerCompanionIpc();
  registerSshIpc();
  registerGitIpc();
  const recoveryMode = process.env.NEXUS_DESKTOP_RECOVERY_SEED === "1"
    ? "seed"
    : process.env.NEXUS_DESKTOP_RECOVERY_RELAUNCH === "1" ? "relaunch" : null;
  if (recoveryMode !== null) {
    try {
      await runRecoverySmoke(recoveryMode);
      metadataStore.close();
      app.exit(0);
      return;
    } catch (error) {
      console.error("NEXUS recovery smoke failed", error);
      metadataStore.close();
      app.exit(1);
      return;
    }
  }
  // Smoke runs must not overwrite the user's real credentials file or hold a listener.
  if (process.env.NEXUS_DESKTOP_SMOKE !== "1") {
    const loaded = loadCompanionNetwork();
    companionNetworkWarning = loaded.warning;
    const startWith = (network: CompanionNetworkConfig): Promise<CompanionService> => startCompanionService({
      hostId: companionHostId,
      displayName: companionHost.displayName,
      readModel: createMetadataReadModel(metadataStore),
      outputSource: createSupervisorOutputSource(hostSupervisor, companionHostId),
      credentialsPath: path.join(app.getPath("userData"), "companion-credentials.json"),
      network,
    });
    try {
      companion = await startWith(loaded.config);
    } catch (error) {
      console.error("NEXUS companion failed to start", error);
      if (loaded.config.mode !== "local") {
        companionNetworkWarning = loaded.config.mode + " mode failed (" + (error instanceof Error ? error.message : String(error)) + "); using local mode";
        try {
          companion = await startWith({ mode: "local" });
        } catch (fallbackError) {
          console.error("NEXUS companion local fallback failed", fallbackError);
        }
      }
    }
  }
  const window = await createWindow();
  if (process.env.NEXUS_DESKTOP_SMOKE === "1") {
    try {
      await runReloadSmoke(window);
      finishSmoke(window, 0);
    } catch (error) {
      console.error("NEXUS reload smoke failed", error);
      finishSmoke(window, 1);
    }
    return;
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  const stopping = companion;
  companion = null;
  void stopping?.stop().catch(() => undefined);
  metadataStore?.close();
});
