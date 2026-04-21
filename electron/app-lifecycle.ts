import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { TerminalHostClient } from "./terminal-host/client";
import { LayoutPersistence } from "./terminal-host/layout-persistence";
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
  registerAllAgents,
} from "./agent-hooks";
import {
  createHookRelay,
  SWEEP_INTERVAL_MS,
} from "./hook-relay";
import { ensureWebviewCli } from "./webview-cli-script";
import { TaskManager, type TaskInfo } from "./task-persistence";
import { PreferencesManager } from "./preferences";
import { KeybindingsManager } from "./keybindings";
import { cleanAgentTitle } from "./title-utils";
import type { AgentStatus, StreamEvent } from "./terminal-host/types";
import { initAutoUpdater } from "./updater";
import { portlessManager } from "./portless";
import { LocalBackend } from "./backend/local-backend";
import { PrewarmManager } from "./prewarm-manager";
import { createWindow, saveZoomLevel } from "./window";
import {
  unseenRespondedTasks,
  unseenInputTasks,
  updateDockBadge as _updateDockBadge,
  maybeSendNotification as _maybeSendNotification,
} from "./notifications";
import * as ptyIpc from "./ipc/pty";
import * as layoutIpc from "./ipc/layout";
import * as projectsIpc from "./ipc/projects";
import * as themeIpc from "./ipc/theme";
import * as portsIpc from "./ipc/ports";
import * as branchesDiffsIpc from "./ipc/branches-diffs";
import * as integrationsIpc from "./ipc/integrations";
import * as webviewIpc from "./ipc/webview";
import * as tasksIpc from "./ipc/tasks";
import * as miscIpc from "./ipc/misc";
import * as processesIpc from "./ipc/processes";

export function initApp(devTitle: string | null): void {
  let mainWindow: BrowserWindow | null = null;

  // Managers
  const client = new TerminalHostClient();
  const backend = new LocalBackend(client);
  const layoutPersistence = new LayoutPersistence();
  const projectManager = new ProjectManager(backend.git);
  const themeManager = new ThemeManager();
  const portScanner = new PortScanner(backend.ports);
  const branchWatcher = new BranchWatcher();
  const diffWatcher = new DiffWatcher(backend.git);
  const githubManager = new GitHubManager();
  const linearManager = new LinearManager();

  const prewarmManager = new PrewarmManager(client, process.env.HOME || "/");
  const agentHookServer = new AgentHookServer();
  const taskManager = new TaskManager();
  const preferencesManager = new PreferencesManager();
  const keybindingsManager = new KeybindingsManager();
  const paneContextMap = new Map<
    string,
    { projectId: string; projectName: string; workspacePath: string; agentCommand: string | null }
  >();

  function updateDockBadge(): void {
    _updateDockBadge(preferencesManager);
  }

  function maybeSendNotification(
    task: TaskInfo,
    prevStatus: string | null | undefined,
    newStatus: AgentStatus,
  ): void {
    _maybeSendNotification(task, prevStatus, newStatus, mainWindow, preferencesManager);
  }

  // Ensure shell integration and agent hooks are set up
  ShellManager.setupZdotdir();
  ensureHookScript();
  ensureWebviewCli();
  registerAllAgents();

  // Set up stream event handler — forward events to renderer
  backend.pty.onEvent((event: StreamEvent) => {
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
            if (task && task.name !== cleaned) {
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
          if (event.agent.status === "idle" && event.agent.kind === null) {
            notifyAgentDetectorGone(event.sessionId);
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

  const webviewServer = webviewIpc.createWebviewServer();

  // Build shared deps object for extracted IPC modules
  const ipcDeps = {
    get mainWindow() {
      return mainWindow;
    },
    backend,
    layoutPersistence,
    projectManager,
    themeManager,
    portScanner,
    branchWatcher,
    diffWatcher,
    githubManager,
    linearManager,
    agentHookServer,
    taskManager,
    preferencesManager,
    keybindingsManager,
    paneContextMap,
    unseenRespondedTasks,
    unseenInputTasks,
    webviewServer,
    workspaceMeta: [],
    prewarmManager,
  };

  ptyIpc.register(ipcDeps);
  layoutIpc.register(ipcDeps);
  projectsIpc.register(ipcDeps);
  themeIpc.register(ipcDeps);
  portsIpc.register(ipcDeps);
  branchesDiffsIpc.register(ipcDeps);
  integrationsIpc.register(ipcDeps);
  webviewIpc.register(ipcDeps);
  tasksIpc.register(ipcDeps);
  miscIpc.register(ipcDeps);
  processesIpc.register(ipcDeps);

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

    mainWindow = createWindow();

    if (devTitle && mainWindow) {
      mainWindow.setTitle(devTitle);
      mainWindow.webContents.on("page-title-updated", (e) => {
        e.preventDefault();
      });
    }

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
    process.env.MANOR_WEBVIEW_PORT = String(webviewServer.serverPort);
    process.env.MANOR_PORTLESS_PORT = String(portlessManager.proxyPort);

    // Connect to daemon (spawns if needed) — now has MANOR_HOOK_PORT in env
    try {
      await backend.connect({ version: app.getVersion() });
    } catch (err) {
      console.error("Failed to connect to terminal host daemon:", err);
    }

    // Pre-warm a terminal session for instant new-task
    prewarmManager.warm().catch(() => {});

    // Set the relay callback now that the client is connected.
    // Hook events route through the daemon's AgentDetector state machine.

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

    const {
      relay,
      sweepStaleSessions,
      notifyAgentDetectorGone,
    } = createHookRelay({
      relayAgentHook: (paneId, status, kind) =>
        backend.pty.relayAgentHook(paneId, status, kind),
      taskManager,
      getPaneContext: (paneId) => paneContextMap.get(paneId),
      unseenRespondedTasks,
      unseenInputTasks,
      broadcastTask,
      maybeSendNotification,
    });

    agentHookServer.setRelay(relay);

    const staleStopSweep = setInterval(() => {
      sweepStaleSessions();
    }, SWEEP_INTERVAL_MS);

    app.on("before-quit", () => {
      clearInterval(staleStopSweep);
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    agentHookServer.stop();
    webviewServer.stop();
    portlessManager.stop();
    prewarmManager.dispose().catch(() => {});
  });
}
