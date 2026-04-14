import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("opencyto", {
  version: "0.1.0",
  openFcsFiles: () => ipcRenderer.invoke("dialog:openFcsFiles") as Promise<string[]>,
  saveWorkspaceFile: (content: string) =>
    ipcRenderer.invoke("workspace:saveFile", content) as Promise<{ canceled?: boolean }>,
  loadWorkspaceFile: () =>
    ipcRenderer.invoke("workspace:loadFile") as Promise<{ canceled?: boolean; content?: string }>,
  appendDebugLog: (message: string) =>
    ipcRenderer.invoke("debug:appendLog", message) as Promise<{ ok: boolean; path?: string; error?: string }>,
  getDebugLogPath: () => ipcRenderer.invoke("debug:getLogPath") as Promise<string>,
  clearDebugLog: () => ipcRenderer.invoke("debug:clearLog") as Promise<{ ok: boolean; path?: string; error?: string }>,
});
