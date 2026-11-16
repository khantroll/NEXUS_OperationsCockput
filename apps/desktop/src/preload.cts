import { contextBridge, ipcRenderer } from "electron";

type HostDataListener = (payload: { attachmentId: string; data: string }) => void;

const host = {
  startDemoSession: () => ipcRenderer.invoke("nexus:host:start-demo"),
  status: (sessionId: string) => ipcRenderer.invoke("nexus:host:status", sessionId),
  attach: (sessionId: string) => ipcRenderer.invoke("nexus:host:attach", sessionId),
  detach: (attachmentId: string) => ipcRenderer.invoke("nexus:host:detach", attachmentId),
  onData: (listener: HostDataListener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: { attachmentId: string; data: string }) => listener(payload);
    ipcRenderer.on("nexus:host:data", wrapped);
    return () => ipcRenderer.removeListener("nexus:host:data", wrapped);
  },
};

contextBridge.exposeInMainWorld("nexusShell", {
  version: "0.1.0-lab",
  capabilities: ["panel-lifecycle-local"],
});
contextBridge.exposeInMainWorld("nexusHost", host);
