import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PtySupervisor, type PtyAttachment } from "@nexus/host-agent/supervisor";

const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);
const rendererPath = path.resolve(currentDirectory, "../renderer/index.html");
const rendererUrl = pathToFileURL(rendererPath).toString();
const hostSupervisor = new PtySupervisor(64 * 1024);
const demoSessionId = "desktop-demo-session";
const attachments = new Map<string, { sessionId: string; owner: WebContents; handle: PtyAttachment }>();

function assertRenderer(event: IpcMainInvokeEvent): void {
  if (!event.senderFrame || event.senderFrame.url !== rendererUrl) throw new Error("unauthorized renderer origin");
}

function assertSessionId(sessionId: unknown): asserts sessionId is string {
  if (sessionId !== demoSessionId) {
    throw new Error("invalid session ID");
  }
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
      return hostSupervisor.start(shell, ["/d", "/c", "node", "-e", "let n=0; setInterval(() => console.log('ipc-tick-'+(++n)), 250);"], {
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
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b1020",
    webPreferences: {
      preload: path.join(currentDirectory, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("destroyed", () => detachOwner(window.webContents));
  window.webContents.on("render-process-gone", () => detachOwner(window.webContents));
  void window.loadFile(rendererPath);
}

app.whenReady().then(() => {
  registerHostIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
