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
import { TaskManager, type TaskInfo } from "./task-persistence";
import { cleanAgentTitle } from "./title-utils";
import type { AgentStatus, StreamEvent } from "./terminal-host/types";
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
const taskManager = new TaskManager();
const paneContextMap = new Map<string, { projectId: string; projectName: string; workspacePath: string }>();

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
            if (updated && mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
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

// ── Task Persistence IPC ──
ipcMain.handle("tasks:getAll", (_event, opts?: { projectId?: string; status?: string; limit?: number; offset?: number }) => {
  return taskManager.getAllTasks(opts);
});

ipcMain.handle("tasks:get", (_event, taskId: string) => {
  assertString(taskId, "taskId");
  // Find task by id (getAllTasks returns all; search through them)
  const all = taskManager.getAllTasks();
  return all.find((t) => t.id === taskId) ?? null;
});

ipcMain.handle("tasks:update", (_event, taskId: string, updates: Record<string, unknown>) => {
  assertString(taskId, "taskId");
  return taskManager.updateTask(taskId, updates);
});

ipcMain.handle("tasks:delete", (_event, taskId: string) => {
  assertString(taskId, "taskId");
  return taskManager.deleteTask(taskId);
});

ipcMain.handle("tasks:setPaneContext", (_event, paneId: string, context: { projectId: string; projectName: string; workspacePath: string }) => {
  assertString(paneId, "paneId");
  assertString(context.projectId, "projectId");
  assertString(context.projectName, "projectName");
  assertString(context.workspacePath, "workspacePath");
  paneContextMap.set(paneId, context);
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

  // Start agent hook server FIRST to get the port number.
  // The port must be in process.env BEFORE the daemon spawns,
  // because the daemon inherits env at spawn time and passes it
  // to PTY sessions (which need MANOR_HOOK_PORT for hook scripts).
  await agentHookServer.start();
  process.env.MANOR_HOOK_PORT = String(agentHookServer.hookPort);

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
    parentComplete: boolean;
    hasBeenActive: boolean;
  }
  const sessionStateMap = new Map<string, SessionState>();

  // Maps paneId to the first (root) sessionId seen on that pane.
  // Used to skip task persistence for subagent sessions.
  const paneRootSessionMap = new Map<string, string>();

  const ACTIVE_STATUSES: Set<AgentStatus> = new Set(["thinking", "working", "requires_input"]);

  function getOrCreateSessionState(sessionId: string): SessionState {
    let state = sessionStateMap.get(sessionId);
    if (!state) {
      state = { subagentCount: 0, parentComplete: false, hasBeenActive: false };
      sessionStateMap.set(sessionId, state);
    }
    return state;
  }

  function broadcastTask(task: TaskInfo): void {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      try {
        mainWindow.webContents.send("task-updated", task);
      } catch {
        // Render frame disposed — safe to ignore
      }
    }
  }

  agentHookServer.setRelay((paneId, status, kind, sessionId, eventType) => {
    client.relayAgentHook(paneId, status, kind);

    // Task persistence: create or update task for this session
    if (!sessionId) {
      console.debug(`[task-lifecycle] No sessionId for ${eventType} on pane ${paneId} — skipping task persistence`);
      return;
    }

    // Root session tracking: first sessionId on a pane is the root (parent).
    // Any different sessionId on the same pane is a subagent — skip task persistence.
    const rootSession = paneRootSessionMap.get(paneId);
    if (!rootSession) {
      paneRootSessionMap.set(paneId, sessionId);
    } else if (rootSession !== sessionId) {
      console.debug(`[task-lifecycle] Subagent session ${sessionId} on pane ${paneId} (root=${rootSession}) — skipping task persistence`);
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
        sessionState.subagentCount = Math.max(0, sessionState.subagentCount - 1);

        // If parent already completed and last subagent finished, transition to completed
        if (sessionState.subagentCount === 0 && sessionState.parentComplete) {
          let task = taskManager.getTaskBySessionId(sessionId);
          if (task) {
            task = taskManager.updateTask(task.id, {
              lastAgentStatus: status,
              status: "completed",
              completedAt: new Date().toISOString(),
            });
            if (task) broadcastTask(task);
          }
          sessionStateMap.delete(sessionId);
          return;
        }
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
      } else {
        task = taskManager.updateTask(task.id, {
          lastAgentStatus: status,
          status: "active",
          ...(task.activatedAt ? {} : { activatedAt: now }),
        });
      }

      if (task) broadcastTask(task);
      return;
    }

    // ── Terminal / completion statuses: complete, error, idle ──

    // Activity gating: if session was never active, skip
    if (!sessionState.hasBeenActive) {
      console.debug(`[task-lifecycle] Skipping ${status} for session ${sessionId} — never activated`);
      return;
    }

    let task = taskManager.getTaskBySessionId(sessionId);

    if (eventType === "Stop") {
      // Parent stop — check subagent count
      if (sessionState.subagentCount > 0) {
        // Subagents still running: mark parent as complete but keep task active
        sessionState.parentComplete = true;
        if (task) {
          task = taskManager.updateTask(task.id, { lastAgentStatus: status });
          if (task) broadcastTask(task);
        }
      } else {
        // No subagents: transition to completed
        if (task) {
          task = taskManager.updateTask(task.id, {
            lastAgentStatus: status,
            status: "completed",
            completedAt: new Date().toISOString(),
          });
          if (task) broadcastTask(task);
        }
        sessionStateMap.delete(sessionId);
      }
    } else if (eventType === "SessionEnd") {
      // Session truly over — always complete
      if (task) {
        task = taskManager.updateTask(task.id, {
          lastAgentStatus: status,
          status: "completed",
          completedAt: new Date().toISOString(),
        });
        if (task) broadcastTask(task);
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
        if (task) broadcastTask(task);
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
});

// Note: We intentionally do NOT disconnect the client or kill the daemon on quit.
// The daemon survives app restarts for session persistence.
