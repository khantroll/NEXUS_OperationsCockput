import { contextBridge, ipcRenderer } from "electron";

type HostDataListener = (payload: { attachmentId: string; data: string }) => void;

const host = {
  startDemoSession: () => ipcRenderer.invoke("nexus:host:start-demo"),
  status: (sessionId: string) => ipcRenderer.invoke("nexus:host:status", sessionId),
  attach: (sessionId: string, mode: "read" | "write" = "read") => ipcRenderer.invoke("nexus:host:attach", sessionId, mode),
  detach: (attachmentId: string) => ipcRenderer.invoke("nexus:host:detach", attachmentId),
  write: (attachmentId: string, data: string) => ipcRenderer.invoke("nexus:host:write", attachmentId, data),
  onData: (listener: HostDataListener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: { attachmentId: string; data: string }) => listener(payload);
    ipcRenderer.on("nexus:host:data", wrapped);
    return () => ipcRenderer.removeListener("nexus:host:data", wrapped);
  },
};
const layout = {
  save: (panels: unknown[]) => ipcRenderer.invoke("nexus:layout:save", panels),
  load: (panelId: string) => ipcRenderer.invoke("nexus:layout:load", panelId),
};
const workspace = {
  list: () => ipcRenderer.invoke("nexus:workspace:list"),
  save: (record: unknown) => ipcRenderer.invoke("nexus:workspace:save", record),
};
const sessions = {
  list: () => ipcRenderer.invoke("nexus:session:list"),
};

contextBridge.exposeInMainWorld("nexusShell", {
  version: "0.1.0-lab",
  capabilities: ["panel-lifecycle-local"],
});
contextBridge.exposeInMainWorld("nexusHost", host);
contextBridge.exposeInMainWorld("nexusLayout", layout);
contextBridge.exposeInMainWorld("nexusWorkspace", workspace);
contextBridge.exposeInMainWorld("nexusSessions", sessions);
