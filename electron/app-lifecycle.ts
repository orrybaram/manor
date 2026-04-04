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
import { ensureWebviewCli } from "./webview-cli-script";
import { TaskManager, type TaskInfo } from "./task-persistence";
import { PreferencesManager } from "./preferences";
import { KeybindingsManager } from "./keybindings";
import { cleanAgentTitle } from "./title-utils";
import type { AgentStatus, StreamEvent } from "./terminal-host/types";
import { initAutoUpdater } from "./updater";
import { portlessManager } from "./portless";
import { LocalBackend } from "./backend/local-backend";
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

  const agentHookServer = new AgentHookServer();
  const taskManager = new TaskManager();
  const preferencesManager = new PreferencesManager();
  const keybindingsManager = new KeybindingsManager();
  const paneContextMap = new Map<
    string,
    { projectId: string; projectName: string; workspacePath: string }
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
      backend.pty.relayAgentHook(paneId, status, kind);

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
            agentSessionId: sessionId,
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
  });
}
