const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("opencyto", {
  version: "0.1.0",
});

