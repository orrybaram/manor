import {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  dialog,
  shell,
  screen,
  nativeImage,
  Notification,
  webContents,
  clipboard,
} from "electron";
import { execFile } from "node:child_process";
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
import { PortScanner, type ActivePort } from "./ports";
import { BranchWatcher } from "./branch-watcher";
import { DiffWatcher } from "./diff-watcher";
import { GitHubManager } from "./github";
import { LinearManager } from "./linear";
import { ShellManager } from "./shell";
import {
  AgentHookServer,
  ensureHookScript,
  registerClaudeHooks,
  registerWebviewMcp,
} from "./agent-hooks";
import { ensureWebviewCli } from "./webview-cli-script";
import { WebviewServer } from "./webview-server";
import { PICKER_SCRIPT } from "./picker-script";
import { assertString, assertPositiveInt } from "./ipc-validate";
import { TaskManager, type TaskInfo } from "./task-persistence";
import { PreferencesManager } from "./preferences";
import { KeybindingsManager } from "./keybindings";
import { cleanAgentTitle } from "./title-utils";
import type { AgentStatus, StreamEvent } from "./terminal-host/types";
import { initAutoUpdater, checkForUpdates, quitAndInstall } from "./updater";
import { portlessManager } from "./portless";

interface WorkspaceMeta {
  path: string;
  projectName: string | null;
  branch: string | null;
  isMain: boolean;
}

let workspaceMeta: WorkspaceMeta[] = [];

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
    icon: path.join(__dirname, "../build/dev-icon.png"),
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 13, y: 13 },
    backgroundColor: "#1e1e2e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
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

  // Open links in default browser instead of Electron popup
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

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
const taskManager = new TaskManager();
const preferencesManager = new PreferencesManager();
const keybindingsManager = new KeybindingsManager();
const paneContextMap = new Map<
  string,
  { projectId: string; projectName: string; workspacePath: string }
>();

const unseenRespondedTasks = new Set<string>();
const unseenInputTasks = new Set<string>();

function updateDockBadge(): void {
  if (!preferencesManager.get("dockBadgeEnabled")) {
    app.dock?.setBadge("");
    return;
  }
  if (unseenInputTasks.size > 0) {
    app.dock?.setBadge(unseenInputTasks.size.toString());
  } else if (unseenRespondedTasks.size > 0) {
    app.dock?.setBadge("·");
  } else {
    app.dock?.setBadge("");
  }
}

// Ensure shell integration and agent hooks are set up
ShellManager.setupZdotdir();
ensureHookScript();
ensureWebviewCli();
registerClaudeHooks();
registerWebviewMcp();

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
      case "agentStatus": {
        mainWindow.webContents.send(
          `pty-agent-status-${event.sessionId}`,
          event.agent,
        );
        // Update persisted task name from agent title
        const cleaned = cleanAgentTitle(event.agent.title);
        if (cleaned) {
          const task = taskManager.getTaskByPaneId(event.sessionId);
          if (task && !task.name) {
            const updated = taskManager.updateTask(task.id, { name: cleaned });
            if (
              updated &&
              mainWindow &&
              !mainWindow.isDestroyed() &&
              !mainWindow.webContents.isDestroyed()
            ) {
              try {
                mainWindow.webContents.send("task-updated", updated);
              } catch {
                // Render frame disposed — safe to ignore
              }
            }
          }
        }
        break;
      }
    }
  } catch (err) {
    // Render frame disposed during window reload or close — safe to ignore
    if (!(err instanceof Error) || !err.message.includes("disposed")) {
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
  (_event, projectId: string, name: string, branch?: string, linkedIssue?: import("./linear").LinkedIssue) => {
    return projectManager.createWorktree(projectId, name, branch, linkedIssue);
  },
);

ipcMain.handle("projects:listRemoteBranches", (_e, projectId: string) =>
  projectManager.listRemoteBranches(projectId),
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
  return themeManager.getThemeByName(name);
});

ipcMain.handle("theme:allColors", async () => {
  return themeManager.loadAllThemeColors();
});

// ── Port Scanner IPC ──
function enrichPorts(ports: ActivePort[]): ActivePort[] {
  const proxyPort = portlessManager.proxyPort;
  const routes: { hostname: string; port: number }[] = [];
  for (const port of ports) {
    const meta = workspaceMeta.find((m) => m.path === port.workspacePath);
    if (meta && proxyPort) {
      const hostname = portlessManager.hostnameForPort(
        meta.path,
        meta.projectName,
        meta.branch,
        meta.isMain,
      );
      routes.push({ hostname, port: port.port });
      // Include proxy port in hostname so renderer can build correct URLs
      port.hostname = `${hostname}:${proxyPort}`;
    }
  }
  portlessManager.updateRoutes(routes);
  return ports;
}

ipcMain.handle("ports:startScanner", () => {
  portScanner.start(mainWindow!, enrichPorts);
});

ipcMain.handle("ports:stopScanner", () => {
  portScanner.stop();
});

ipcMain.handle("ports:updateWorkspacePaths", (_event, paths: string[]) => {
  portScanner.updateWorkspacePaths(paths);
});

ipcMain.handle(
  "ports:updateWorkspaceMetadata",
  (_event, meta: WorkspaceMeta[]) => {
    workspaceMeta = meta;
  },
);

ipcMain.handle("ports:scanNow", async () => {
  const ports = await portScanner.scanNow();
  return enrichPorts(ports);
});

ipcMain.handle("ports:killPort", async (_event, pid: number) => {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process may have already exited — ignore
  }
  // Re-scan immediately so UI updates
  const ports = await portScanner.scanNow();
  const enriched = enrichPorts(ports);
  mainWindow?.webContents.send("ports-changed", enriched);
});

// ── Branch Watcher IPC ──
ipcMain.handle("branches:start", (_event, paths: string[]) => {
  branchWatcher.start(mainWindow!, paths);
});

ipcMain.handle("branches:stop", () => {
  branchWatcher.stop();
});

// ── Diff Watcher IPC ──
ipcMain.handle("diffs:start", (_event, workspaces: Record<string, string>) => {
  diffWatcher.start(mainWindow!, workspaces);
});

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

ipcMain.handle(
  "github:getMyIssues",
  (_event, repoPath: string, limit?: number) => {
    return githubManager.getMyIssues(repoPath, limit);
  },
);

ipcMain.handle(
  "github:getAllIssues",
  (_event, repoPath: string, limit?: number) => {
    return githubManager.getAllIssues(repoPath, limit);
  },
);

ipcMain.handle(
  "github:getIssueDetail",
  (_event, repoPath: string, issueNumber: number) => {
    return githubManager.getIssueDetail(repoPath, issueNumber);
  },
);

ipcMain.handle(
  "github:assignIssue",
  (_event, repoPath: string, issueNumber: number) => {
    return githubManager.assignIssue(repoPath, issueNumber);
  },
);

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

ipcMain.handle("linear:getIssueDetail", async (_event, issueId: string) => {
  return linearManager.getIssueDetail(issueId);
});

ipcMain.handle(
  "linear:getAllIssues",
  async (
    _event,
    teamIds: string[],
    options?: { stateTypes?: string[]; limit?: number },
  ) => {
    return linearManager.getAllIssues(teamIds, options);
  },
);

ipcMain.handle("linear:startIssue", async (_event, issueId: string) => {
  return linearManager.startIssue(issueId);
});

ipcMain.handle(
  "linear:linkIssueToWorkspace",
  (_e, projectId: string, workspacePath: string, issue: import("./linear").LinkedIssue) =>
    projectManager.linkIssueToWorkspace(projectId, workspacePath, issue),
);

ipcMain.handle(
  "linear:unlinkIssueFromWorkspace",
  (_e, projectId: string, workspacePath: string, issueId: string) =>
    projectManager.unlinkIssueFromWorkspace(projectId, workspacePath, issueId),
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
  const allowed = ["https:", "http:", "file:", "x-apple.systempreferences:"];
  if (!allowed.includes(parsed.protocol)) {
    throw new Error(`Blocked protocol: ${parsed.protocol}`);
  }
  return shell.openExternal(url);
});

ipcMain.handle("shell:openInEditor", async (_event, dirPath: string) => {
  assertString(dirPath, "dirPath");
  const editor = preferencesManager.get("defaultEditor");
  if (!editor) {
    return shell.openPath(dirPath);
  }
  return new Promise<string>((resolve) => {
    execFile(editor, [dirPath], (err) => {
      resolve(err ? err.message : "");
    });
  });
});

// ── Clipboard IPC ──
ipcMain.handle("clipboard:writeText", (_event, text: string) => {
  clipboard.writeText(text);
});

// ── Task Persistence IPC ──
ipcMain.handle(
  "tasks:getAll",
  (
    _event,
    opts?: {
      projectId?: string;
      status?: string;
      limit?: number;
      offset?: number;
    },
  ) => {
    return taskManager.getAllTasks(opts);
  },
);

ipcMain.handle("tasks:get", (_event, taskId: string) => {
  assertString(taskId, "taskId");
  // Find task by id (getAllTasks returns all; search through them)
  const all = taskManager.getAllTasks();
  return all.find((t) => t.id === taskId) ?? null;
});

ipcMain.handle(
  "tasks:update",
  (_event, taskId: string, updates: Record<string, unknown>) => {
    assertString(taskId, "taskId");
    return taskManager.updateTask(taskId, updates);
  },
);

ipcMain.handle("tasks:delete", (_event, taskId: string) => {
  assertString(taskId, "taskId");
  unseenRespondedTasks.delete(taskId);
  unseenInputTasks.delete(taskId);
  const result = taskManager.deleteTask(taskId);
  updateDockBadge();
  return result;
});

ipcMain.handle("tasks:markSeen", (_event, taskId: string) => {
  assertString(taskId, "taskId");
  unseenRespondedTasks.delete(taskId);
  unseenInputTasks.delete(taskId);
  updateDockBadge();
});

ipcMain.handle(
  "tasks:setPaneContext",
  (
    _event,
    paneId: string,
    context: { projectId: string; projectName: string; workspacePath: string },
  ) => {
    assertString(paneId, "paneId");
    assertString(context.projectId, "projectId");
    assertString(context.projectName, "projectName");
    assertString(context.workspacePath, "workspacePath");
    paneContextMap.set(paneId, context);
  },
);

// ── Preferences IPC ──
ipcMain.handle("preferences:getAll", () => {
  return preferencesManager.getAll();
});

ipcMain.handle("preferences:set", (_event, key: string, value: unknown) => {
  assertString(key, "key");
  preferencesManager.set(
    key as keyof import("./preferences").AppPreferences,
    value as never,
  );
});

ipcMain.handle("preferences:playSound", (_event, soundName: string) => {
  execFile("afplay", [`/System/Library/Sounds/${soundName}.aiff`]);
});

preferencesManager.onChange((prefs) => {
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed()
  ) {
    try {
      mainWindow.webContents.send("preferences-changed", prefs);
    } catch {
      // Render frame disposed — safe to ignore
    }
  }
});

// ── Keybindings IPC ──
ipcMain.handle("keybindings:getAll", () => {
  return keybindingsManager.getAll();
});

ipcMain.handle(
  "keybindings:set",
  (_event, commandId: string, combo: string) => {
    assertString(commandId, "commandId");
    assertString(combo, "combo");
    keybindingsManager.set(commandId, combo);
  },
);

ipcMain.handle("keybindings:reset", (_event, commandId: string) => {
  assertString(commandId, "commandId");
  keybindingsManager.reset(commandId);
});

ipcMain.handle("keybindings:resetAll", () => {
  keybindingsManager.resetAll();
});

// ── Webview registry ──
const webviewRegistry = new Map<string, number>();
const webviewServer = new WebviewServer(webviewRegistry);
const webviewContextMenuCleanup = new Map<string, () => void>();
const webviewEscapeCleanup = new Map<string, () => void>();

ipcMain.handle(
  "webview:register",
  (_event, paneId: string, webContentsId: number) => {
    assertString(paneId, "paneId");
    webviewRegistry.set(paneId, webContentsId);
    webviewServer.attachConsoleListener(paneId);

    const rendererWebContents = _event.sender;

    const wc = webContents.fromId(webContentsId);
    if (wc) {
      const handler = (
        _ev: Electron.Event,
        params: Electron.ContextMenuParams,
      ) => {
        const menu = Menu.buildFromTemplate([
          {
            label: "Inspect Element",
            click: () => wc.inspectElement(params.x, params.y),
          },
        ]);
        menu.popup();
      };
      wc.on("context-menu", handler);
      webviewContextMenuCleanup.set(paneId, () => {
        wc.off("context-menu", handler);
      });

      let lastEscapeTime = 0;
      const escapeHandler = (
        ev: Electron.Event,
        input: Electron.Input,
      ) => {
        if (
          input.key === "Escape" &&
          input.type === "keyDown" &&
          !input.alt &&
          !input.control &&
          !input.meta &&
          !input.shift
        ) {
          const now = Date.now();
          if (now - lastEscapeTime < 500) {
            ev.preventDefault();
            rendererWebContents.send("webview:escape", paneId);
            lastEscapeTime = 0;
          } else {
            lastEscapeTime = now;
          }
        }
      };
      wc.on("before-input-event", escapeHandler);
      webviewEscapeCleanup.set(paneId, () => {
        wc.off("before-input-event", escapeHandler);
      });
    }
  },
);

ipcMain.handle("webview:unregister", (_event, paneId: string) => {
  assertString(paneId, "paneId");
  webviewContextMenuCleanup.get(paneId)?.();
  webviewContextMenuCleanup.delete(paneId);
  webviewEscapeCleanup.get(paneId)?.();
  webviewEscapeCleanup.delete(paneId);
  webviewServer.detachConsoleListener(paneId);
  webviewRegistry.delete(paneId);
});

ipcMain.handle("webview:start-picker", async (_event, paneId: string) => {
  assertString(paneId, "paneId");
  const webContentsId = webviewRegistry.get(paneId);
  if (!webContentsId) return;
  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) return;

  await wc.executeJavaScript(PICKER_SCRIPT);

  const listener = (
    _ev: Electron.Event,
    _level: number,
    message: string,
  ) => {
    if (
      mainWindow &&
      !mainWindow.isDestroyed() &&
      !mainWindow.webContents.isDestroyed()
    ) {
      if (message.startsWith("__MANOR_PICK__:")) {
        wc.off("console-message", listener);
        try {
          const result = JSON.parse(
            message.slice("__MANOR_PICK__:".length),
          );
          mainWindow.webContents.send("webview:picker-result", paneId, result);
        } catch {
          // ignore parse errors
        }
      } else if (message === "__MANOR_PICK_CANCEL__") {
        wc.off("console-message", listener);
        mainWindow.webContents.send("webview:picker-cancel", paneId);
      }
    }
  };

  wc.on("console-message", listener);
});

ipcMain.handle("webview:cancel-picker", async (_event, paneId: string) => {
  assertString(paneId, "paneId");
  const webContentsId = webviewRegistry.get(paneId);
  if (!webContentsId) return;
  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) return;
  await wc.executeJavaScript(
    "if (window.__manor_picker_cancel__) window.__manor_picker_cancel__();",
  );
});

ipcMain.handle("webview:zoom-in", (_event, paneId: string) => {
  assertString(paneId, "paneId");
  const webContentsId = webviewRegistry.get(paneId);
  if (!webContentsId) return;
  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) return;
  wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 5));
});

ipcMain.handle("webview:zoom-out", (_event, paneId: string) => {
  assertString(paneId, "paneId");
  const webContentsId = webviewRegistry.get(paneId);
  if (!webContentsId) return;
  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) return;
  wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3));
});

ipcMain.handle("webview:zoom-reset", (_event, paneId: string) => {
  assertString(paneId, "paneId");
  const webContentsId = webviewRegistry.get(paneId);
  if (!webContentsId) return;
  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) return;
  wc.setZoomLevel(0);
});

keybindingsManager.onChange((overrides) => {
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed()
  ) {
    try {
      mainWindow.webContents.send("keybindings-changed", overrides);
    } catch {
      // Render frame disposed — safe to ignore
    }
  }
});

function maybeSendNotification(
  task: TaskInfo,
  prevStatus: string | null | undefined,
  newStatus: AgentStatus,
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isFocused()) return;

  let title: string;
  if (
    newStatus === "responded" &&
    prevStatus !== "responded" &&
    preferencesManager.get("notifyOnResponse")
  ) {
    title = "Agent responded";
  } else if (
    newStatus === "requires_input" &&
    prevStatus !== "requires_input" &&
    preferencesManager.get("notifyOnRequiresInput")
  ) {
    title = "Agent needs input";
  } else {
    return;
  }

  const notification = new Notification({
    title,
    body: [task.name || "Agent", task.projectName].filter(Boolean).join(" — "),
    silent: true,
  });
  notification.on("click", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("notification:navigate-to-task", task.id);
  });
  notification.show();
  const soundName = preferencesManager.get("notificationSound");
  if (typeof soundName === "string") {
    execFile("afplay", [`/System/Library/Sounds/${soundName}.aiff`]);
  }
}

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
              const next = Math.min(
                mainWindow.webContents.getZoomFactor() + 0.1,
                3,
              );
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
              const next = Math.max(
                mainWindow.webContents.getZoomFactor() - 0.1,
                0.3,
              );
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
    const iconPath = path.join(__dirname, "../build/dev-icon.png");
    if (fs.existsSync(iconPath)) {
      app.dock.setIcon(nativeImage.createFromPath(iconPath));
    }
  }

  createWindow();

  // Initialize auto-updater
  if (mainWindow) {
    initAutoUpdater(mainWindow);
  }

  // Start agent hook server FIRST to get the port number.
  // The port must be in process.env BEFORE the daemon spawns,
  // because the daemon inherits env at spawn time and passes it
  // to PTY sessions (which need MANOR_HOOK_PORT for hook scripts).
  await agentHookServer.start();
  process.env.MANOR_HOOK_PORT = String(agentHookServer.hookPort);

  await webviewServer.start();
  await portlessManager.start();

  // Connect to daemon (spawns if needed) — now has MANOR_HOOK_PORT in env
  try {
    await client.connect();
  } catch (err) {
    console.error("Failed to connect to terminal host daemon:", err);
  }

  // Set the relay callback now that the client is connected.
  // Hook events route through the daemon's AgentDetector state machine.

  // Session state map for activity gating and subagent tracking
  interface SessionState {
    subagentCount: number;
    hasBeenActive: boolean;
  }
  const sessionStateMap = new Map<string, SessionState>();

  // Maps paneId to the first (root) sessionId seen on that pane.
  // Used to skip task persistence for subagent sessions.
  const paneRootSessionMap = new Map<string, string>();

  const ACTIVE_STATUSES: Set<AgentStatus> = new Set([
    "thinking",
    "working",
    "requires_input",
  ]);

  function getOrCreateSessionState(sessionId: string): SessionState {
    let state = sessionStateMap.get(sessionId);
    if (!state) {
      state = { subagentCount: 0, hasBeenActive: false };
      sessionStateMap.set(sessionId, state);
    }
    return state;
  }

  function broadcastTask(task: TaskInfo): void {
    if (
      mainWindow &&
      !mainWindow.isDestroyed() &&
      !mainWindow.webContents.isDestroyed()
    ) {
      try {
        mainWindow.webContents.send("task-updated", task);
      } catch {
        // Render frame disposed — safe to ignore
      }
    }
    updateDockBadge();
  }

  // Update dock badge whenever preferences change (e.g. user toggles dockBadgeEnabled)
  preferencesManager.onChange(() => {
    updateDockBadge();
  });

  agentHookServer.setRelay((paneId, status, kind, sessionId, eventType) => {
    client.relayAgentHook(paneId, status, kind);

    // Task persistence: create or update task for this session
    if (!sessionId) {
      console.debug(
        `[task-lifecycle] No sessionId for ${eventType} on pane ${paneId} — skipping task persistence`,
      );
      return;
    }

    // Root session tracking: first sessionId on a pane is the root (parent).
    // Any different sessionId on the same pane is a subagent — skip task persistence.
    const rootSession = paneRootSessionMap.get(paneId);
    if (!rootSession) {
      paneRootSessionMap.set(paneId, sessionId);
    } else if (rootSession !== sessionId) {
      console.debug(
        `[task-lifecycle] Subagent session ${sessionId} on pane ${paneId} (root=${rootSession}) — skipping task persistence`,
      );
      return;
    }

    const sessionState = getOrCreateSessionState(sessionId);

    // ── Active statuses: thinking, working, requires_input ──
    if (ACTIVE_STATUSES.has(status)) {
      sessionState.hasBeenActive = true;

      // Subagent tracking on active events
      if (eventType === "SubagentStart") {
        sessionState.subagentCount++;
      } else if (eventType === "SubagentStop") {
        sessionState.subagentCount = Math.max(
          0,
          sessionState.subagentCount - 1,
        );
      }

      // Create or update task
      let task = taskManager.getTaskBySessionId(sessionId);
      const now = new Date().toISOString();

      if (!task) {
        const paneContext = paneContextMap.get(paneId);
        task = taskManager.createTask({
          claudeSessionId: sessionId,
          name: null,
          status: "active",
          completedAt: null,
          projectId: paneContext?.projectId ?? null,
          projectName: paneContext?.projectName ?? null,
          workspacePath: paneContext?.workspacePath ?? null,
          cwd: paneContext?.workspacePath ?? "",
          agentKind: kind,
          paneId,
          lastAgentStatus: status,
        });
        // Set activatedAt immediately after creation
        task = taskManager.updateTask(task.id, { activatedAt: now });
        if (task && status === "requires_input") {
          unseenInputTasks.add(task.id);
        }
      } else {
        const prevStatus = task.lastAgentStatus;
        task = taskManager.updateTask(task.id, {
          lastAgentStatus: status,
          status: "active",
          ...(task.activatedAt ? {} : { activatedAt: now }),
        });
        if (task) {
          if (status === "requires_input") {
            unseenInputTasks.add(task.id);
          }
          maybeSendNotification(task, prevStatus, status);
        }
      }

      if (task) broadcastTask(task);
      return;
    }

    // ── Terminal / completion statuses: complete, error, idle ──

    // Activity gating: if session was never active, skip
    if (!sessionState.hasBeenActive) {
      console.debug(
        `[task-lifecycle] Skipping ${status} for session ${sessionId} — never activated`,
      );
      return;
    }

    let task = taskManager.getTaskBySessionId(sessionId);

    if (eventType === "Stop") {
      // If subagents are still running, this Stop is from a subagent — ignore it.
      // The parent's real Stop will arrive once subagentCount reaches 0.
      if (sessionState.subagentCount > 0) {
        return;
      }

      // No subagents: set responded and keep task active
      if (task) {
        const prevStatus = task.lastAgentStatus;
        task = taskManager.updateTask(task.id, {
          lastAgentStatus: "responded",
          status: "active",
        });
        if (task) {
          unseenRespondedTasks.add(task.id);
          maybeSendNotification(task, prevStatus, "responded");
          broadcastTask(task);
        }
      }
    } else if (eventType === "SessionEnd") {
      // Session truly over — always complete
      if (task) {
        task = taskManager.updateTask(task.id, {
          lastAgentStatus: "complete",
          status: "completed",
          completedAt: new Date().toISOString(),
        });
        if (task) {
          unseenRespondedTasks.delete(task.id);
          unseenInputTasks.delete(task.id);
          broadcastTask(task);
        }
      }
      sessionStateMap.delete(sessionId);
      // Allow pane to accept a new root session
      paneRootSessionMap.delete(paneId);
    } else if (eventType === "StopFailure") {
      // Error — transition regardless of subagent state
      if (task) {
        task = taskManager.updateTask(task.id, {
          lastAgentStatus: status,
          status: "error",
          completedAt: new Date().toISOString(),
        });
        if (task) {
          unseenRespondedTasks.delete(task.id);
          unseenInputTasks.delete(task.id);
          broadcastTask(task);
        }
      }
      sessionStateMap.delete(sessionId);
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  agentHookServer.stop();
  webviewServer.stop();
  portlessManager.stop();
});

// Note: We intentionally do NOT disconnect the client or kill the daemon on quit.
// The daemon survives app restarts for session persistence.
