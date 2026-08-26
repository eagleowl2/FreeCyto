const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const fs = require("fs");
const path = require("path");

const isDev = !app.isPackaged;
const debugLogPath = path.join(app.getPath("temp"), "freecyto-log-transform-debug.log");

function appendDebugLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(debugLogPath, line, "utf8");
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    // Vite dev server – keep in sync with vite.config.ts.
    // Port is pinned: backend/main.py's CORS allowlist only admits :5173.
    await win.loadURL("http://localhost:5173/");
  } else {
    // Must be the *built* bundle. ../index.html is the Vite source entry, which
    // references raw /src/main.tsx and cannot run in a packaged app.
    await win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

ipcMain.handle("dialog:openFcsFiles", async () => {
  const result = await dialog.showOpenDialog({
    title: "Open FCS Files",
    filters: [{ name: "FCS Files", extensions: ["fcs", "lmd"] }],
    properties: ["openFile", "multiSelections"],
  });
  return result.filePaths ?? [];
});

ipcMain.handle("workspace:saveFile", async (_, content) => {
  const result = await dialog.showSaveDialog({
    title: "Save Workspace",
    defaultPath: "workspace.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  fs.writeFileSync(result.filePath, content, "utf8");
  return { canceled: false, path: result.filePath };
});

ipcMain.handle("workspace:loadFile", async () => {
  const result = await dialog.showOpenDialog({
    title: "Load Workspace",
    filters: [{ name: "JSON", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (result.canceled || !result.filePaths?.length) return { canceled: true };
  const content = fs.readFileSync(result.filePaths[0], "utf8");
  return { canceled: false, content };
});

ipcMain.handle("debug:appendLog", async (_, message) => {
  try {
    appendDebugLog(String(message));
    return { ok: true, path: debugLogPath };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle("debug:getLogPath", async () => {
  return debugLogPath;
});

ipcMain.handle("debug:clearLog", async () => {
  try {
    fs.writeFileSync(debugLogPath, "", "utf8");
    return { ok: true, path: debugLogPath };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

app.whenReady().then(() => {
  void createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

