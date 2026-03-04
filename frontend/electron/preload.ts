import { contextBridge } from "electron";

// Minimal preload – we will expand this later for file dialogs, etc.
contextBridge.exposeInMainWorld("opencyto", {
  version: "0.1.0",
});

