import { app, BrowserWindow, Menu, nativeImage, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
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
import { homeWorkspaceDir } from "./paths";
import {
  AgentHookServer,
  ensureHookScript,
  registerAllAgents,
} from "./agent-hooks";
import { createHookRelay, SWEEP_INTERVAL_MS } from "./hook-relay";
import { ensureWebviewCli } from "./webview-cli-script";
import { TaskManager, type TaskInfo } from "./task-persistence";
import { NotificationStore } from "./notification-store";
import { PreferencesManager } from "./preferences";
import { KeybindingsManager } from "./keybindings";
import { cleanAgentTitle } from "./title-utils";
import type { AgentStatus, StreamEvent } from "./terminal-host/types";
import { initAutoUpdater, checkForUpdates } from "./updater";
import { portlessManager } from "./portless";
import { LocalBackend } from "./backend/local-backend";
import { PrewarmManager } from "./prewarm-manager";
import { RemoteDeviceStore } from "./remote-control/devices";
import { RemoteControlServer } from "./remote-control/server";
import { TunnelManager } from "./remote-control/tunnel";
import { RemoteControlController } from "./remote-control/controller";
import { PushManager } from "./remote-control/push";
import { createWindow, saveZoomLevel } from "./window";
import {
  unseenRespondedTasks,
  unseenInputTasks,
  updateDockBadge as _updateDockBadge,
  maybeSendNotification as _maybeSendNotification,
  sendTaskUpdate,
  setNotificationStore,
} from "./notifications";
import * as ptyIpc from "./ipc/pty";
import * as layoutIpc from "./ipc/layout";
import * as projectsIpc from "./ipc/projects";
import * as themeIpc from "./ipc/theme";
import * as portsIpc from "./ipc/ports";
import * as branchesDiffsIpc from "./ipc/branches-diffs";
import { killAllActivePushes } from "./ipc/branches-diffs";
import * as integrationsIpc from "./ipc/integrations";
import * as webviewIpc from "./ipc/webview";
import * as tasksIpc from "./ipc/tasks";
import * as notificationsIpc from "./ipc/notifications";
import * as miscIpc from "./ipc/misc";
import * as processesIpc from "./ipc/processes";
import * as windowIpc from "./ipc/window";
import * as remoteControlIpc from "./ipc/remote-control";

// Extract stream event handler for testability
export function handleStreamEvent(
  event: StreamEvent,
  window: BrowserWindow,
  taskManager: TaskManager,
  preferencesManager: PreferencesManager,
  notifyAgentDetectorGone?: (sessionId: string) => void,
): void {
  try {
    switch (event.type) {
      case "data":
        window.webContents.send(
          `pty-output-${event.sessionId}`,
          event.data,
          event.seq,
        );
        break;
      case "exit":
        window.webContents.send(`pty-exit-${event.sessionId}`);
        break;
      case "cwd":
        window.webContents.send(`pty-cwd-${event.sessionId}`, event.cwd);
        // Update task's cwd if active and differs from current
        {
          const task = taskManager.getTaskByPaneId(event.sessionId);
          if (task && task.status === "active" && task.cwd !== event.cwd) {
            const updated = taskManager.updateTask(task.id, { cwd: event.cwd });
            if (updated) {
              sendTaskUpdate(window, updated, preferencesManager);
            }
          }
        }
        break;
      case "error":
        window.webContents.send(`pty-error-${event.sessionId}`, event.message);
        break;
      case "agentStatus": {
        window.webContents.send(
          `pty-agent-status-${event.sessionId}`,
          event.agent,
        );
        // Update persisted task name from agent title
        const cleaned = cleanAgentTitle(event.agent.title);
        if (cleaned) {
          const task = taskManager.getTaskByPaneId(event.sessionId);
          if (task && task.name !== cleaned) {
            const updated = taskManager.updateTask(task.id, { name: cleaned });
            if (updated) {
              sendTaskUpdate(window, updated, preferencesManager);
            }
          }
        }
        if (event.agent.status === "idle" && event.agent.kind === null) {
          if (notifyAgentDetectorGone) {
            notifyAgentDetectorGone(event.sessionId);
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
}

export function initApp(devTitle: string | null): void {
  // `mainWindow` is the PRIMARY renderer window. The `get mainWindow()` getter
  // on ipcDeps keeps returning it, so every existing handler is unaffected.
  let mainWindow: BrowserWindow | null = null;

  // ── Window registry ────────────────────────────────────────────────────
  // All live renderer windows (primary + any detached popup windows) are
  // tracked here so stream events can be broadcast to every window that might
  // host a pane. Detached windows are additionally keyed by their windowId so
  // ticket 2 can associate a handoff payload with the right window.
  const rendererWindows = new Set<BrowserWindow>();
  const detachedWindows = new Map<string, BrowserWindow>();

  function trackRendererWindow(win: BrowserWindow): void {
    rendererWindows.add(win);
    win.on("closed", () => {
      rendererWindows.delete(win);
    });
  }

  /**
   * Create the primary window and wire the lifecycle that belongs to it.
   *
   * `mainWindow` is nulled on `closed`: a closed window leaves a live JS wrapper
   * around a freed native window, and the app outlives it on macOS (popouts keep
   * running), so anything still reading `deps.mainWindow` would hand that
   * wrapper to `dialog`, `parent:`, or `webContents.send` (see #164).
   */
  function openPrimaryWindow(): BrowserWindow {
    const win = createWindow();
    mainWindow = win;
    trackRendererWindow(win);

    // Backstop cleanup: child popup windows are parented to the main window so
    // Chromium closes them with it, but explicitly flush the tracking registry
    // on close so no entries or listeners leak.
    win.on("close", () => {
      webviewIpc.closeAllChildWindows();
    });
    win.on("closed", () => {
      if (mainWindow === win) mainWindow = null;
    });

    if (devTitle) {
      win.setTitle(devTitle);
      win.webContents.on("page-title-updated", (e) => {
        e.preventDefault();
      });
    }

    return win;
  }

  /** Live, non-destroyed renderer windows (primary + detached). */
  function getRendererWindows(): BrowserWindow[] {
    return Array.from(rendererWindows).filter(
      (win) => !win.isDestroyed() && !win.webContents.isDestroyed(),
    );
  }

  /**
   * Register a detached popup window created via `createDetachedWindow`. Ticket
   * 2 calls this after creating the window so it can be reached by its windowId
   * (e.g. to deliver a one-shot detach payload) and receives broadcast events.
   */
  function registerDetachedWindow(windowId: string, win: BrowserWindow): void {
    detachedWindows.set(windowId, win);
    trackRendererWindow(win);
    win.on("closed", () => {
      detachedWindows.delete(windowId);
    });
  }

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
  // PreferencesManager must be constructed before TaskManager so we can pass
  // the user's configured retention into the prune step.
  const preferencesManager = new PreferencesManager();
  const taskManager = new TaskManager(
    undefined,
    preferencesManager.get("taskRetentionDays"),
  );
  const keybindingsManager = new KeybindingsManager();
  // ADR-162's durable notification log. Handed to `notifications.ts` so the
  // single recording site inside `presentNotification` can reach it.
  const notificationStore = new NotificationStore();
  setNotificationStore(notificationStore);

  // ADR-161's remote-control surface. Constructed here so the status sink and
  // the quit hook can see it; deliberately *not* started — remote control is
  // off until the user turns it on, and even then the listener is loopback-only
  // until they separately start a tunnel.
  const remoteDeviceStore = new RemoteDeviceStore();
  const remotePush = new PushManager(remoteDeviceStore);
  const remoteControlServer = new RemoteControlServer(
    () => ({
      projectManager,
      githubManager,
      linearManager,
      layoutPersistence,
      taskManager,
      backend,
    }),
    remoteDeviceStore,
    // Rate limiter, audit log, and client directory all take their defaults.
    { push: remotePush },
  );
  // Detected, never installed; started only by an explicit user action. The
  // manager is constructed here so shutdown can guarantee the child dies with
  // the app — a tunnel outliving Manor is the feature's worst failure mode.
  const remoteTunnel = new TunnelManager({
    which: (bin) => backend.shell.which(bin),
    spawn: (command, args) =>
      spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }),
  });
  const remoteControl = new RemoteControlController(
    remoteControlServer,
    remoteDeviceStore,
    remoteTunnel,
    () => safeStorage.isEncryptionAvailable(),
    remotePush,
  );
  const paneContextMap = new Map<
    string,
    {
      projectId: string;
      projectName: string;
      workspacePath: string;
      agentCommand: string | null;
    }
  >();

  function updateDockBadge(): void {
    _updateDockBadge(preferencesManager);
  }

  function maybeSendNotification(
    task: TaskInfo,
    prevStatus: string | null | undefined,
    newStatus: AgentStatus,
  ): void {
    _maybeSendNotification(
      task,
      prevStatus,
      newStatus,
      mainWindow,
      preferencesManager,
    );
    // A second sink on the same transition, not a second detector: whatever
    // moves the dock badge is what a paired phone hears about. What that means
    // — a stream event, a push, or nothing at all — belongs to
    // `RemoteControlController`, not here.
    remoteControl.onAgentStatus(task, prevStatus, newStatus, {
      notify: preferencesManager.get("notifyOnRequiresInput"),
    });
  }

  // Ensure shell integration and agent hooks are set up
  ShellManager.setupZdotdir();
  ensureHookScript();
  ensureWebviewCli();
  registerAllAgents();
  // The Home surface's harness runs in ~/.manor/home. Create it once here
  // instead of on every new session's launch command.
  fs.mkdirSync(homeWorkspaceDir(), { recursive: true });

  // Mutable reference to notifyAgentDetectorGone — will be set after hook relay is created
  let notifyAgentDetectorGone: ((sessionId: string) => void) | undefined;

  // Set up stream event handler — broadcast events to every live renderer
  // window. A detached window hosting a terminal pane must receive its `pty:*`
  // stream events; windows that don't own the pane ignore them harmlessly.
  backend.pty.onEvent((event: StreamEvent) => {
    for (const win of getRendererWindows()) {
      // Check that the main frame is still available (avoids "Render frame was
      // disposed" errors during window reload/close).
      try {
        if (!win.webContents.mainFrame) continue;
      } catch {
        continue;
      }
      handleStreamEvent(
        event,
        win,
        taskManager,
        preferencesManager,
        notifyAgentDetectorGone,
      );
    }
  });

  // ── Register all IPC handlers before window creation to avoid race conditions ──

  const webviewServer = webviewIpc.createWebviewServer(
    projectManager,
    githubManager,
    linearManager,
    layoutPersistence,
    taskManager,
    backend,
  );

  // Build shared deps object for extracted IPC modules
  const ipcDeps = {
    get mainWindow() {
      return mainWindow;
    },
    getRendererWindows,
    registerDetachedWindow,
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
    notificationStore,
    preferencesManager,
    keybindingsManager,
    paneContextMap,
    unseenRespondedTasks,
    unseenInputTasks,
    webviewServer,
    workspaceMeta: [],
    prewarmManager,
    remoteControl,
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
  notificationsIpc.register(ipcDeps);
  miscIpc.register(ipcDeps);
  processesIpc.register(ipcDeps);
  windowIpc.register(ipcDeps);
  remoteControlIpc.register(ipcDeps);

  // ── App lifecycle ──
  app.whenReady().then(async () => {
    // Custom menu: remove default Back (Cmd+[) / Forward (Cmd+]) so they reach the renderer
    const menu = Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          ...(app.isPackaged
            ? [
                { type: "separator" as const },
                {
                  label: "Check for Updates…",
                  click: () => checkForUpdates(),
                },
              ]
            : []),
          { type: "separator" as const },
          { role: "services" as const },
          { type: "separator" as const },
          { role: "hide" as const },
          { role: "hideOthers" as const },
          { role: "unhide" as const },
          { type: "separator" as const },
          { role: "quit" as const },
        ],
      },
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

    openPrimaryWindow();

    // Initialize auto-updater. It reads the primary window on each event rather
    // than capturing one — the window it started with may since have been closed
    // and replaced.
    initAutoUpdater(() => mainWindow);

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
      sendTaskUpdate(mainWindow, task, preferencesManager);
    }

    // Update dock badge whenever preferences change (e.g. user toggles dockBadgeEnabled)
    preferencesManager.onChange(() => {
      updateDockBadge();
    });

    const {
      relay,
      sweepStaleSessions,
      notifyAgentDetectorGone: notifyAgentDetectorGoneFn,
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

    // Now that the hook relay is created, set the notifyAgentDetectorGone reference
    notifyAgentDetectorGone = notifyAgentDetectorGoneFn;

    agentHookServer.setRelay(relay);

    const staleStopSweep = setInterval(() => {
      sweepStaleSessions();
    }, SWEEP_INTERVAL_MS);

    app.on("before-quit", () => {
      clearInterval(staleStopSweep);
    });

    // Reopen the PRIMARY window, not just "a" window: with a popout still open
    // the old zero-windows test never fired, so a user who closed the main
    // window could not get it back without quitting.
    app.on("activate", () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        openPrimaryWindow();
      }
    });
  });

  // `before-quit` covers the ordinary path. This covers the ones that skip it
  // — `app.exit()`, an unhandled fatal — where a surviving tunnel would leave
  // this machine reachable with nothing listening behind it.
  process.on("exit", () => {
    remoteControl.killTunnelNow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    agentHookServer.stop();
    webviewServer.stop();
    // Takes the tunnel down first, then the listener. A tunnel must never
    // outlive the app that opened it.
    void remoteControl.shutdown();
    portlessManager.stop();
    prewarmManager.dispose().catch(() => {});
    killAllActivePushes();
  });
}
