import {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  dialog,
  shell,
  screen,
  nativeImage,
} from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TerminalHostClient } from "./terminal-host/client";
import {
  LayoutPersistence,
  type PersistedWorkspace,
} from "./terminal-host/layout-persistence";
import { ScrollbackWriter } from "./terminal-host/scrollback";
import { ProjectManager } from "./persistence";
import { ThemeManager } from "./theme";
import { PortScanner } from "./ports";
import { BranchWatcher } from "./branch-watcher";
import { DiffWatcher } from "./diff-watcher";
import { GitHubManager } from "./github";
import { LinearManager } from "./linear";
import { ShellManager } from "./shell";
import {
  AgentHookServer,
  ensureHookScript,
  registerClaudeHooks,
} from "./agent-hooks";
import { assertString, assertPositiveInt } from "./ipc-validate";
import type { StreamEvent } from "./terminal-host/types";
import { initAutoUpdater, checkForUpdates, quitAndInstall } from "./updater";

let mainWindow: BrowserWindow | null = null;

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

function manorDataDir(): string {
  return process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "Manor")
    : path.join(os.homedir(), ".local", "share", "Manor");
}

function windowBoundsPath(): string {
  return path.join(manorDataDir(), "window-bounds.json");
}

function zoomLevelPath(): string {
  return path.join(manorDataDir(), "zoom-level.json");
}

function loadZoomLevel(): number {
  try {
    const data = fs.readFileSync(zoomLevelPath(), "utf-8");
    return JSON.parse(data).zoomFactor ?? 1;
  } catch {
    return 1;
  }
}

function saveZoomLevel(factor: number): void {
  try {
    const p = zoomLevelPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ zoomFactor: factor }));
  } catch {
    /* ignore */
  }
}

function loadWindowBounds(): WindowBounds | null {
  try {
    const data = fs.readFileSync(windowBoundsPath(), "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function saveWindowBounds(win: BrowserWindow): void {
  const bounds: WindowBounds = {
    ...win.getBounds(),
    isMaximized: win.isMaximized(),
  };
  try {
    const boundsPath = windowBoundsPath();
    fs.mkdirSync(path.dirname(boundsPath), { recursive: true });
    fs.writeFileSync(boundsPath, JSON.stringify(bounds));
  } catch {
    /* ignore write errors */
  }
}

function boundsAreVisible(bounds: WindowBounds): boolean {
  const displays = screen.getAllDisplays();
  // Check if the window's center point is within any display
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  return displays.some((display) => {
    const { x, y, width, height } = display.workArea;
    return cx >= x && cx < x + width && cy >= y && cy < y + height;
  });
}

function createWindow() {
  const saved = loadWindowBounds();
  const useSaved = saved && boundsAreVisible(saved);

  mainWindow = new BrowserWindow({
    width: useSaved ? saved.width : 1200,
    height: useSaved ? saved.height : 800,
    ...(useSaved ? { x: saved.x, y: saved.y } : {}),
    minWidth: 400,
    minHeight: 300,
    icon: path.join(__dirname, "../build/icon.png"),
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 13, y: 13 },
    backgroundColor: "#1e1e2e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (useSaved && saved.isMaximized) {
    mainWindow.maximize();
  }

  // Persist bounds on move/resize (debounced)
  let boundsTimer: ReturnType<typeof setTimeout> | null = null;
  const persistBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        saveWindowBounds(mainWindow);
      }
    }, 500);
  };
  mainWindow.on("resize", persistBounds);
  mainWindow.on("move", persistBounds);
  mainWindow.on("close", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      saveWindowBounds(mainWindow);
    }
  });

  // Restore persisted zoom level
  const savedZoom = loadZoomLevel();
  mainWindow.webContents.setZoomFactor(savedZoom);

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

// Managers
const client = new TerminalHostClient(app.getVersion());
const layoutPersistence = new LayoutPersistence();
const projectManager = new ProjectManager();
const themeManager = new ThemeManager();
const portScanner = new PortScanner();
const branchWatcher = new BranchWatcher();
const diffWatcher = new DiffWatcher();
const githubManager = new GitHubManager();
const linearManager = new LinearManager();

const agentHookServer = new AgentHookServer();

// Ensure shell integration and agent hooks are set up
ShellManager.setupZdotdir();
ensureHookScript();
registerClaudeHooks();

// Set up stream event handler — forward events to renderer
client.onEvent((event: StreamEvent) => {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    mainWindow.webContents.isDestroyed()
  )
    return;
  // Check that the main frame is still available (avoids "Render frame was
  // disposed" errors during window reload/close).
  try {
    if (!mainWindow.webContents.mainFrame) return;
  } catch {
    return;
  }
  try {
    switch (event.type) {
      case "data":
        mainWindow.webContents.send(
          `pty-output-${event.sessionId}`,
          event.data,
        );
        break;
      case "exit":
        mainWindow.webContents.send(`pty-exit-${event.sessionId}`);
        break;
      case "cwd":
        mainWindow.webContents.send(`pty-cwd-${event.sessionId}`, event.cwd);
        break;
      case "error":
        mainWindow.webContents.send(
          `pty-error-${event.sessionId}`,
          event.message,
        );
        break;
      case "agentStatus":
        mainWindow.webContents.send(
          `pty-agent-status-${event.sessionId}`,
          event.agent,
        );
        break;
    }
  } catch (err) {
    // Render frame disposed during window reload or close — safe to ignore
    if (
      !(err instanceof Error) ||
      !err.message.includes("disposed")
    ) {
      console.error("Error in stream event handler:", err);
    }
  }
});

// ── Register all IPC handlers before window creation to avoid race conditions ──

// ── PTY IPC (via daemon) ──
ipcMain.handle(
  "pty:create",
  async (
    _event,
    paneId: string,
    cwd: string | null,
    cols: number,
    rows: number,
  ) => {
    assertString(paneId, "paneId");
    if (cwd !== null) assertString(cwd, "cwd");
    assertPositiveInt(cols, "cols");
    assertPositiveInt(rows, "rows");
    try {
      const result = await client.createOrAttach(
        paneId,
        cwd || process.env.HOME || "/",
        cols,
        rows,
      );
      // Return snapshot to the renderer so it can write it exactly once,
      // avoiding duplicate writes from StrictMode double-mounting.
      return {
        ok: true,
        snapshot: result.snapshot?.screenAnsi || null,
      };
    } catch (err) {
      console.error(`Failed to create/attach PTY for ${paneId}:`, err);
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
);

ipcMain.handle("pty:write", (_event, paneId: string, data: string) => {
  assertString(paneId, "paneId");
  assertString(data, "data");
  client.writeNoAck(paneId, data);
});

ipcMain.handle(
  "pty:resize",
  async (_event, paneId: string, cols: number, rows: number) => {
    assertString(paneId, "paneId");
    assertPositiveInt(cols, "cols");
    assertPositiveInt(rows, "rows");
    try {
      await client.resize(paneId, cols, rows);
    } catch {
      // ignore resize errors
    }
  },
);

ipcMain.handle("pty:close", async (_event, paneId: string) => {
  assertString(paneId, "paneId");
  try {
    await client.kill(paneId);
  } catch {
    // ignore close errors
  }
});

ipcMain.handle("pty:detach", async (_event, paneId: string) => {
  assertString(paneId, "paneId");
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
  assertString(name, "name");
  assertString(projectPath, "path");
  return projectManager.addProject(name, projectPath);
});

ipcMain.handle("projects:remove", (_event, projectId: string) => {
  projectManager.removeProject(projectId);
});

ipcMain.handle(
  "projects:selectWorkspace",
  (_event, projectId: string, workspaceIndex: number) => {
    projectManager.selectWorkspace(projectId, workspaceIndex);
  },
);

ipcMain.handle(
  "projects:removeWorktree",
  (_event, projectId: string, worktreePath: string, deleteBranch?: boolean) => {
    return projectManager.removeWorktree(projectId, worktreePath, deleteBranch);
  },
);

ipcMain.handle(
  "projects:createWorktree",
  (_event, projectId: string, name: string, branch?: string) => {
    return projectManager.createWorktree(projectId, name, branch);
  },
);

ipcMain.handle(
  "projects:renameWorkspace",
  (_event, projectId: string, workspacePath: string, newName: string) => {
    projectManager.renameWorkspace(projectId, workspacePath, newName);
  },
);

ipcMain.handle(
  "projects:reorderWorkspaces",
  (_event, projectId: string, orderedPaths: string[]) => {
    projectManager.reorderWorkspaces(projectId, orderedPaths);
  },
);

ipcMain.handle("projects:reorder", (_event, orderedIds: string[]) => {
  projectManager.reorderProjects(orderedIds);
});

ipcMain.handle(
  "projects:update",
  (
    _event,
    projectId: string,
    updates: import("./persistence").ProjectUpdatableFields,
  ) => {
    return projectManager.updateProject(projectId, updates);
  },
);

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

// ── Branch Watcher IPC ──
ipcMain.handle("branches:start", (_event, paths: string[]) => {
  branchWatcher.start(mainWindow!, paths);
});

ipcMain.handle("branches:stop", () => {
  branchWatcher.stop();
});

// ── Diff Watcher IPC ──
ipcMain.handle(
  "diffs:start",
  (_event, workspaces: Record<string, string>) => {
    diffWatcher.start(mainWindow!, workspaces);
  },
);

ipcMain.handle("diffs:stop", () => {
  diffWatcher.stop();
});

// ── GitHub IPC ──
ipcMain.handle(
  "github:getPrForBranch",
  (_event, repoPath: string, branch: string) => {
    return githubManager.getPrForBranch(repoPath, branch);
  },
);

ipcMain.handle(
  "github:getPrsForBranches",
  (_event, repoPath: string, branches: string[]) => {
    return githubManager.getPrsForBranches(repoPath, branches);
  },
);

ipcMain.handle("github:checkStatus", () => githubManager.checkStatus());

// ── Linear IPC ──
ipcMain.handle("linear:connect", async (_event, apiKey: string) => {
  assertString(apiKey, "apiKey");
  linearManager.saveToken(apiKey);
  try {
    const viewer = await linearManager.getViewer();
    return viewer;
  } catch (err) {
    linearManager.clearToken();
    throw err;
  }
});

ipcMain.handle("linear:disconnect", () => {
  linearManager.clearToken();
});

ipcMain.handle("linear:isConnected", () => {
  return linearManager.isConnected();
});

ipcMain.handle("linear:getViewer", async () => {
  return linearManager.getViewer();
});

ipcMain.handle("linear:getTeams", async () => {
  return linearManager.getTeams();
});

ipcMain.handle(
  "linear:getMyIssues",
  async (
    _event,
    teamIds: string[],
    options?: { stateTypes?: string[]; limit?: number },
  ) => {
    return linearManager.getMyIssues(teamIds, options);
  },
);

ipcMain.handle(
  "linear:getIssueDetail",
  async (_event, issueId: string) => {
    return linearManager.getIssueDetail(issueId);
  },
);

ipcMain.handle("linear:autoMatch", async () => {
  const projects = await projectManager.getProjects();
  const teams = await linearManager.getTeams();
  const matches = linearManager.autoMatchProjects(
    projects.map((p) => ({ id: p.id, name: p.name })),
    teams,
  );
  // Apply matches to projects without existing associations
  for (const [projectId, association] of Object.entries(matches)) {
    const project = projects.find((p) => p.id === projectId);
    if (project && project.linearAssociations.length === 0) {
      projectManager.updateProject(projectId, {
        linearAssociations: [association],
      });
    }
  }
  return matches;
});

// ── Dialog IPC ──
ipcMain.handle("dialog:openDirectory", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ── Updater IPC ──
ipcMain.handle("updater:checkForUpdates", () => checkForUpdates());
ipcMain.handle("updater:quitAndInstall", () => quitAndInstall());

// ── Shell ──
ipcMain.handle("shell:openExternal", async (_event, url: string) => {
  assertString(url, "url");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL format");
  }
  const allowed = ["https:", "http:", "file:"];
  if (!allowed.includes(parsed.protocol)) {
    throw new Error(`Blocked protocol: ${parsed.protocol}`);
  }
  return shell.openExternal(url);
});

// ── App lifecycle ──
app.whenReady().then(async () => {
  // Custom menu: remove default Back (Cmd+[) / Forward (Cmd+]) so they reach the renderer
  const menu = Menu.buildFromTemplate([
    { role: "appMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        {
          label: "Actual Size",
          accelerator: "CmdOrCtrl+0",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.setZoomFactor(1);
              saveZoomLevel(1);
            }
          },
        },
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+=",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              const next = Math.min(mainWindow.webContents.getZoomFactor() + 0.1, 3);
              mainWindow.webContents.setZoomFactor(next);
              saveZoomLevel(next);
            }
          },
        },
        {
          label: "Zoom Out",
          accelerator: "CmdOrCtrl+-",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              const next = Math.max(mainWindow.webContents.getZoomFactor() - 0.1, 0.3);
              mainWindow.webContents.setZoomFactor(next);
              saveZoomLevel(next);
            }
          },
        },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ]);
  Menu.setApplicationMenu(menu);

  // Set Dock icon on macOS
  if (process.platform === "darwin") {
    const iconPath = path.join(__dirname, "../build/icon.png");
    if (fs.existsSync(iconPath)) {
      app.dock.setIcon(nativeImage.createFromPath(iconPath));
    }
  }

  createWindow();

  // Initialize auto-updater
  if (mainWindow) {
    initAutoUpdater(mainWindow);
  }

  // Connect to daemon (spawns if needed)
  try {
    await client.connect();
  } catch (err) {
    console.error("Failed to connect to terminal host daemon:", err);
  }

  // Start agent hook server (receives lifecycle events from Claude Code, etc.)
  // Must happen after daemon connect so the client is ready to relay events.
  await agentHookServer.start((paneId, status) => {
    client.relayAgentHook(paneId, status);
  });
  process.env.MANOR_HOOK_PORT = String(agentHookServer.hookPort);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  agentHookServer.stop();
});

// Note: We intentionally do NOT disconnect the client or kill the daemon on quit.
// The daemon survives app restarts for session persistence.
