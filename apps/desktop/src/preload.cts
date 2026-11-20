import { contextBridge, ipcRenderer } from "electron";

type HostDataListener = (payload: { attachmentId: string; data: string }) => void;

const host = {
  startDemoSession: () => ipcRenderer.invoke("nexus:host:start-demo"),
  startProfile: (profile: unknown, sessionId?: string) => ipcRenderer.invoke("nexus:host:start-profile", profile, sessionId),
  status: (sessionId: string) => ipcRenderer.invoke("nexus:host:status", sessionId),
  attach: (sessionId: string, mode: "read" | "write" = "read") => ipcRenderer.invoke("nexus:host:attach", sessionId, mode),
  detach: (attachmentId: string) => ipcRenderer.invoke("nexus:host:detach", attachmentId),
  write: (attachmentId: string, data: string) => ipcRenderer.invoke("nexus:host:write", attachmentId, data),
  resize: (attachmentId: string, cols: number, rows: number) => ipcRenderer.invoke("nexus:host:resize", attachmentId, cols, rows),
  interrupt: (sessionId: string) => ipcRenderer.invoke("nexus:host:interrupt", sessionId),
  restartProfile: (sessionId: string, profile: unknown) => ipcRenderer.invoke("nexus:host:restart-profile", sessionId, profile),
  terminate: (sessionId: string, confirmationToken: string) => ipcRenderer.invoke("nexus:host:terminate", sessionId, confirmationToken),
  onData: (listener: HostDataListener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: { attachmentId: string; data: string }) => listener(payload);
    ipcRenderer.on("nexus:host:data", wrapped);
    return () => ipcRenderer.removeListener("nexus:host:data", wrapped);
  },
};
const layout = {
  save: (panels: unknown[]) => ipcRenderer.invoke("nexus:layout:save", panels),
  load: (panelId: string) => ipcRenderer.invoke("nexus:layout:load", panelId),
  list: (workspaceId: string) => ipcRenderer.invoke("nexus:layout:list", workspaceId),
  export: (workspaceId: string) => ipcRenderer.invoke("nexus:layout:export", workspaceId),
  import: (serialized: string) => ipcRenderer.invoke("nexus:layout:import", serialized),
};
const workspace = {
  list: () => ipcRenderer.invoke("nexus:workspace:list"),
  save: (record: unknown) => ipcRenderer.invoke("nexus:workspace:save", record),
  onCreateRequested: (listener: () => void) => {
    const wrapped = (): void => listener();
    ipcRenderer.on("nexus:workspace:new", wrapped);
    return () => ipcRenderer.removeListener("nexus:workspace:new", wrapped);
  },
};
const metro = {
  previewConfig: () => ipcRenderer.invoke("nexus:metro:preview-config"),
  onWindowVisibility: (listener: (payload: { hidden: boolean }) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: { hidden: boolean }) => listener(payload);
    ipcRenderer.on("nexus:window:visibility", wrapped);
    return () => ipcRenderer.removeListener("nexus:window:visibility", wrapped);
  },
};
const sessions = {
  list: () => ipcRenderer.invoke("nexus:session:list"),
  clearExited: () => ipcRenderer.invoke("nexus:session:clear-exited"),
  clearLab: () => ipcRenderer.invoke("nexus:session:clear-lab"),
};

const ssh = {
  list: () => ipcRenderer.invoke("nexus:ssh:list"),
  start: (profileId: string) => ipcRenderer.invoke("nexus:ssh:start", profileId),
  openFile: () => ipcRenderer.invoke("nexus:ssh:open-file"),
};
const git = {
  inspect: (request: { cwd?: string; relativeDir?: string }) => ipcRenderer.invoke("nexus:git:inspect", request),
};
const companion = {
  info: () => ipcRenderer.invoke("nexus:companion:info"),
  openNetworkFile: () => ipcRenderer.invoke("nexus:companion:open-network-file"),
};

contextBridge.exposeInMainWorld("nexusShell", {
  version: "0.1.0-lab",
  capabilities: ["panel-lifecycle-local"],
});
contextBridge.exposeInMainWorld("nexusHost", host);
contextBridge.exposeInMainWorld("nexusLayout", layout);
contextBridge.exposeInMainWorld("nexusWorkspace", workspace);
contextBridge.exposeInMainWorld("nexusMetro", metro);
contextBridge.exposeInMainWorld("nexusSessions", sessions);
contextBridge.exposeInMainWorld("nexusCompanion", companion);
contextBridge.exposeInMainWorld("nexusSsh", ssh);
contextBridge.exposeInMainWorld("nexusGit", git);
