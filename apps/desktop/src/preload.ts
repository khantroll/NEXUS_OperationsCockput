import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("nexusShell", {
  version: "0.1.0-lab",
  capabilities: ["panel-lifecycle-local"],
});
