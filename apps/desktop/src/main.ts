import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PtySupervisor, type PtyAttachment } from "@nexus/host-agent/supervisor";
import { MetadataStore } from "@nexus/storage/metadata";
import type { PanelRecord, WorkspaceRecord } from "@nexus/contracts";

const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);
const rendererPath = path.resolve(currentDirectory, "../renderer/index.html");
const rendererUrl = pathToFileURL(rendererPath).toString();
let hostSupervisor: PtySupervisor;
let metadataStore: MetadataStore;
const demoSessionId = "desktop-demo-session";
const attachments = new Map<string, { sessionId: string; owner: WebContents; handle: PtyAttachment }>();

function assertRenderer(event: IpcMainInvokeEvent): void {
  if (!event.senderFrame || event.senderFrame.url !== rendererUrl) {
    throw new Error(`unauthorized renderer origin: ${event.senderFrame?.url ?? "none"}`);
  }
}

function assertSessionId(sessionId: unknown): asserts sessionId is string {
  if (sessionId !== demoSessionId) {
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

function detachOwner(owner: WebContents): void {
  for (const [attachmentId, attachment] of attachments) {
    if (attachment.owner === owner) {
      attachment.handle.detach();
      attachments.delete(attachmentId);
    }
  }
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
  ipcMain.handle("nexus:host:status", (event, sessionId: unknown) => {
    assertRenderer(event);
    assertSessionId(sessionId);
    return hostSupervisor.snapshot(sessionId);
  });
  ipcMain.handle("nexus:host:attach", (event, sessionId: unknown) => {
    assertRenderer(event);
    assertSessionId(sessionId);
    const attachmentId = crypto.randomUUID();
    const handle = hostSupervisor.attach(sessionId, "read");
    handle.onData((data) => {
      if (!event.sender.isDestroyed()) event.sender.send("nexus:host:data", { attachmentId, data });
    });
    attachments.set(attachmentId, { sessionId, owner: event.sender, handle });
    return { attachmentId, replay: handle.replay };
  });
  ipcMain.handle("nexus:host:detach", (event, attachmentId: unknown) => {
    assertRenderer(event);
    if (typeof attachmentId !== "string") throw new Error("invalid attachment ID");
    const attachment = attachments.get(attachmentId);
    if (!attachment || attachment.owner !== event.sender) throw new Error("unknown attachment");
    attachment.handle.detach();
    attachments.delete(attachmentId);
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
  ipcMain.handle("nexus:workspace:list", (event) => {
    assertRenderer(event);
    return metadataStore.listWorkspaces();
  });
  ipcMain.handle("nexus:workspace:save", (event, workspace: unknown) => {
    assertRenderer(event);
    if (!isWorkspaceRecord(workspace)) throw new Error("invalid workspace metadata");
    metadataStore.saveWorkspace(workspace);
  });
  ipcMain.handle("nexus:session:list", (event) => {
    assertRenderer(event);
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
  window.webContents.on("render-process-gone", () => detachOwner(window.webContents));
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
  await evaluate<void>("save layout metadata", `window.nexusLayout.save([{
    panelId: 'demo-panel', sessionId: '${demoSessionId}', workspaceId: 'default',
    placement: 'parked', revision: 2,
    homeAnchor: { workspaceId: 'default', groupId: 'terminals', splitPath: ['root', 'center'],
      tabIndex: 0, fallbackZone: 'center', layoutRevision: 1 }
  }])`);
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
      const panel = document.querySelector('[data-panel-id="demo-panel"]');
      return panel ? { placement: panel.getAttribute('data-panel-placement'), revision: Number(panel.getAttribute('data-panel-revision')) } : null;
    })()`);
    if (renderedPanel === null) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const persistedPanel = await evaluate<{ placement: string; revision: number } | null>("verify persisted layout", "window.nexusLayout.load('demo-panel')");
  if (renderedPanel?.placement !== "parked" || renderedPanel.revision !== 2) {
    const body = await evaluate<string>("inspect rendered body", "document.body.innerHTML.slice(0, 1000)");
    throw new Error(`renderer reload did not recover persisted layout metadata: rendered=${JSON.stringify(renderedPanel)} persisted=${JSON.stringify(persistedPanel)} body=${JSON.stringify(body)}`);
  }
  await evaluate<void>("detach reloaded attachment", `window.nexusHost.detach('${secondAttachment.attachmentId}')`);
  console.log("NEXUS reload smoke passed", { sessionId: second.sessionId, pid: second.pid });
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
    hostId: "xenos-windows",
    hostBootEpoch,
  });
  registerHostIpc();
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
  metadataStore?.close();
});
