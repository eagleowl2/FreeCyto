const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("opencyto", {
  version: "0.1.0",
  openFcsFiles: () => ipcRenderer.invoke("dialog:openFcsFiles"),
  saveWorkspaceFile: (content) => ipcRenderer.invoke("workspace:saveFile", content),
  loadWorkspaceFile: () => ipcRenderer.invoke("workspace:loadFile"),
  appendDebugLog: (message) => ipcRenderer.invoke("debug:appendLog", message),
  getDebugLogPath: () => ipcRenderer.invoke("debug:getLogPath"),
  clearDebugLog: () => ipcRenderer.invoke("debug:clearLog"),
});

