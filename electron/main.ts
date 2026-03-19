import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import path from "node:path";
import { TerminalHostClient } from "./terminal-host/client";
import { LayoutPersistence, type PersistedWorkspace, type PersistedLayout } from "./terminal-host/layout-persistence";
import { ScrollbackWriter } from "./terminal-host/scrollback";
import { ProjectManager } from "./persistence";
import { ThemeManager } from "./theme";
import { PortScanner } from "./ports";
import { GitHubManager } from "./github";
import { ShellManager } from "./shell";
import type { StreamEvent } from "./terminal-host/types";

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 300,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 13, y: 13 },
    backgroundColor: "#1e1e2e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

// Managers
const client = new TerminalHostClient();
const layoutPersistence = new LayoutPersistence();
const projectManager = new ProjectManager();
const themeManager = new ThemeManager();
const portScanner = new PortScanner();
const githubManager = new GitHubManager();

// Ensure shell integration is set up
ShellManager.setupZdotdir();

// Set up stream event handler — forward events to renderer
client.onEvent((event: StreamEvent) => {
  if (!mainWindow) return;
  switch (event.type) {
    case "data":
      mainWindow.webContents.send(`pty-output-${event.sessionId}`, event.data);
      break;
    case "exit":
      mainWindow.webContents.send(`pty-exit-${event.sessionId}`);
      break;
    case "cwd":
      mainWindow.webContents.send(`pty-cwd-${event.sessionId}`, event.cwd);
      break;
    case "error":
      mainWindow.webContents.send(`pty-error-${event.sessionId}`, event.message);
      break;
  }
});

// ── Register all IPC handlers before window creation to avoid race conditions ──

// ── PTY IPC (via daemon) ──
ipcMain.handle("pty:create", async (_event, paneId: string, cwd: string | null, cols: number, rows: number) => {
  try {
    const result = await client.createOrAttach(paneId, cwd || process.env.HOME || "/", cols, rows);
    // If we got a snapshot (warm restore), send it to the renderer
    if (result.snapshot && result.snapshot.screenAnsi) {
      mainWindow?.webContents.send(`pty-output-${paneId}`, result.snapshot.screenAnsi);
    }
    return { ok: true };
  } catch (err) {
    console.error(`Failed to create/attach PTY for ${paneId}:`, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("pty:write", (_event, paneId: string, data: string) => {
  client.writeNoAck(paneId, data);
});

ipcMain.handle("pty:resize", async (_event, paneId: string, cols: number, rows: number) => {
  try {
    await client.resize(paneId, cols, rows);
  } catch {
    // ignore resize errors
  }
});

ipcMain.handle("pty:close", async (_event, paneId: string) => {
  try {
    await client.kill(paneId);
  } catch {
    // ignore close errors
  }
});

ipcMain.handle("pty:detach", async (_event, paneId: string) => {
  try {
    await client.detach(paneId);
  } catch {
    // ignore detach errors
  }
});

// ── Layout Persistence IPC ──
ipcMain.handle("layout:save", (_event, workspace: PersistedWorkspace) => {
  try {
    layoutPersistence.saveWorkspace(workspace);
  } catch (err) {
    console.error("Failed to save layout:", err);
  }
});

ipcMain.handle("layout:load", () => {
  return layoutPersistence.load();
});

ipcMain.handle("layout:getRestoredSessions", async () => {
  // Get live daemon sessions and persisted scrollback sessions
  // so the renderer can reconcile on startup
  try {
    const daemonSessions = await client.listSessions();
    const persistedSessionIds = ScrollbackWriter.listPersistedSessions();
    return {
      daemonSessions,
      persistedSessionIds,
    };
  } catch {
    return { daemonSessions: [], persistedSessionIds: [] };
  }
});

// ── Persistence IPC ──
ipcMain.handle("projects:getAll", () => {
  return projectManager.getProjects();
});

ipcMain.handle("projects:getSelectedIndex", () => {
  return projectManager.getSelectedProjectIndex();
});

ipcMain.handle("projects:select", (_event, index: number) => {
  projectManager.selectProject(index);
});

ipcMain.handle("projects:add", (_event, name: string, projectPath: string) => {
  return projectManager.addProject(name, projectPath);
});

ipcMain.handle("projects:remove", (_event, projectId: string) => {
  projectManager.removeProject(projectId);
});

ipcMain.handle("projects:selectWorkspace", (_event, projectId: string, workspaceIndex: number) => {
  projectManager.selectWorkspace(projectId, workspaceIndex);
});

ipcMain.handle("projects:removeWorktree", (_event, projectPath: string, worktreePath: string) => {
  projectManager.removeWorktree(projectPath, worktreePath);
});

// ── Theme IPC ──
ipcMain.handle("theme:get", () => {
  return themeManager.getTheme();
});

ipcMain.handle("theme:setSelected", (_event, name: string) => {
  themeManager.setSelectedThemeName(name);
  return themeManager.getTheme();
});

ipcMain.handle("theme:getSelectedName", () => {
  return themeManager.getSelectedThemeName();
});

ipcMain.handle("theme:hasGhosttyConfig", () => {
  return themeManager.hasGhosttyConfig();
});

ipcMain.handle("theme:preview", (_event, name: string) => {
  if (name === "__ghostty__") return themeManager.loadGhosttyConfigTheme();
  if (name === "__default__") return null; // use DEFAULT_THEME on renderer
  return themeManager.loadGhosttyTheme(name);
});

ipcMain.handle("theme:allColors", async () => {
  return themeManager.loadAllThemeColors();
});

// ── Port Scanner IPC ──
ipcMain.handle("ports:startScanner", () => {
  portScanner.start(mainWindow!);
});

ipcMain.handle("ports:stopScanner", () => {
  portScanner.stop();
});

ipcMain.handle("ports:updateWorkspacePaths", (_event, paths: string[]) => {
  portScanner.updateWorkspacePaths(paths);
});

ipcMain.handle("ports:scanNow", () => {
  return portScanner.scanNow();
});

// ── GitHub IPC ──
ipcMain.handle("github:getPrForBranch", (_event, repoPath: string, branch: string) => {
  return githubManager.getPrForBranch(repoPath, branch);
});

ipcMain.handle("github:getPrsForBranches", (_event, repoPath: string, branches: string[]) => {
  return githubManager.getPrsForBranches(repoPath, branches);
});

// ── Dialog IPC ──
ipcMain.handle("dialog:openDirectory", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ── Shell ──
ipcMain.handle("shell:openExternal", (_event, url: string) => {
  return shell.openExternal(url);
});

// ── App lifecycle ──
app.whenReady().then(async () => {
  createWindow();

  // Connect to daemon (spawns if needed)
  try {
    await client.connect();
  } catch (err) {
    console.error("Failed to connect to terminal host daemon:", err);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Note: We intentionally do NOT disconnect the client or kill the daemon on quit.
// The daemon survives app restarts for session persistence.
