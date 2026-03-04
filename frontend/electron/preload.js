const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("opencyto", {
  version: "0.1.0",
  openFcsFiles: () => ipcRenderer.invoke("dialog:openFcsFiles"),
});

