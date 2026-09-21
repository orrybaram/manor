import { app, BrowserWindow, nativeImage, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { TerminalHostClient } from "./terminal-host/client";
import { LayoutPersistence } from "./terminal-host/layout-persistence";
import { LayoutStore } from "./layout/layout-store";
import { publishRendererBroadcast } from "./renderer-broadcast";
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
import { ensureManorCli } from "./manor-cli-install";
import { AgentManager, type AgentInfo } from "./agent-persistence";
import { NotificationStore } from "./notification-store";
import { StatsStore } from "./stats-store";
import { countBusyAgents } from "./stats-signals";
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
import { BridgeServer } from "./bridge/server";
import { WsBridgeServer } from "./bridge/transports/ws";
import { IpcBridgeTransport } from "./bridge/transports/ipc";
import { TAILSCALE_APP_CLI, TunnelManager } from "./remote-control/tunnel";
import { RemoteControlController } from "./remote-control/controller";
import { PushManager } from "./remote-control/push";
import type { ControlDeps } from "./routes/types";
import { createWindow, saveZoomLevel } from "./window";
import { installAppMenu, type AppMenuController } from "./app-menu";
import {
  unseenRespondedAgents,
  unseenInputAgents,
  updateDockBadge as _updateDockBadge,
  maybeSendNotification as _maybeSendNotification,
  sendAgentUpdate,
  sendNotificationsUpdate,
  setNotificationStore,
  setStatsStore,
} from "./notifications";
import { killAllActivePushes } from "./bridge/handlers/branches-diffs";
import { wireStatsBroadcast } from "./bridge/handlers/stats";
import {
  wirePreferencesBroadcast,
  wireKeybindingsBroadcast,
} from "./bridge/handlers/preferences";
import { wireRemoteControlStatus } from "./bridge/handlers/remote-control";
import * as webviewIpc from "./ipc/webview";
import * as nativeIpc from "./ipc/native";
import * as windowIpc from "./ipc/window";
import * as menuIpc from "./ipc/menu";

/**
 * What a stream event means to *main* — which, since ADR-180 ticket 5, is no
 * longer "forward it to a window".
 *
 * Every pane's output, exit, cwd, resize, error and agent status used to go
 * out on a channel of its own — `pty-output-${paneId}` and five siblings, to
 * every live window, whether or not it had the pane. They are bridge event
 * frames now (D5): `BridgeServer.handleStreamEvent` publishes them as
 * `pty.output`/`exit`/`cwd`/`resized`/`agentStatus`/`error` keyed by paneId,
 * and a renderer hears only the panes it subscribed to — the same filter a
 * browser has always had, and the same `seq` riding along with the output
 * that lets a warm restore drop what its snapshot already covered (ADR-159).
 *
 * What is left here is the bookkeeping those sends were tangled up with: an
 * agent's cwd follows its shell, its name follows the title its harness
 * draws, and a harness that disappears is reported gone. Only two of the six
 * event types say anything about that, which is why the other four are
 * absent rather than empty.
 *
 * There is no `window` parameter. This used to take one and the caller
 * looped over every renderer window to feed it, because `sendAgentUpdate`
 * addressed the legacy `agent-updated` channel to whichever window it was
 * handed. The loop went when `agents` crossed (ADR-180 ticket 9); the
 * argument every caller still passed and nobody read went with ticket 15.
 * The bridge reaches every window and every browser on its own.
 */
export function handleStreamEvent(
  event: StreamEvent,
  agentManager: AgentManager,
  preferencesManager: PreferencesManager,
  notifyAgentDetectorGone?: (sessionId: string) => void,
): void {
  try {
    switch (event.type) {
      case "cwd":
        // Update agent's cwd if active and differs from current
        {
          const agent = agentManager.getAgentByPaneId(event.sessionId);
          if (agent && agent.status === "active" && agent.cwd !== event.cwd) {
            const updated = agentManager.updateAgent(agent.id, {
              cwd: event.cwd,
            });
            if (updated) {
              sendAgentUpdate(updated, preferencesManager);
            }
          }
        }
        break;
      case "agentStatus": {
        // Update persisted agent name from agent title — unless the user
        // pinned a name of their own, which the title sync must not clobber.
        const cleaned = cleanAgentTitle(event.agent.title);
        if (cleaned) {
          const agent = agentManager.getAgentByPaneId(event.sessionId);
          if (agent && !agent.namePinned && agent.name !== cleaned) {
            const updated = agentManager.updateAgent(agent.id, {
              name: cleaned,
            });
            if (updated) {
              sendAgentUpdate(updated, preferencesManager);
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
  // Installed inside `app.whenReady()` below; `ipcDeps.appMenu` reads this
  // through a getter so the IPC modules can be registered before then, as
  // they are today (ADR-170 §4).
  let appMenu: AppMenuController;

  // ── Window registry ────────────────────────────────────────────────────
  // All live renderer windows (primary + any detached popup windows) are
  // tracked here so stream events can be broadcast to every window that might
  // host a pane. Detached windows are additionally keyed by their windowId,
  // which is how one is reached after it was created.
  const rendererWindows = new Set<BrowserWindow>();
  const detachedWindows = new Map<string, BrowserWindow>();

  // What a closed window held — the panes it was a viewer of, and the tab it
  // claimed — is released when its bridge connection drops (the IPC
  // transport drops it when the `webContents` is destroyed), not here: the
  // connection is what holds them, and `BridgeServer.onDisconnect` below is
  // the one place that hears it go.
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
  /**
   * ADR-179: layout is the Manor server's, not a renderer's. One broadcaster
   * feeds every audience from the one place the layout changes.
   *
   * It used to be two — a publish for the bridge, and a `layout:changed`
   * send around every live window. The second one went with the namespace
   * (ADR-180 ticket 6): a desktop window is a bridge connection now, so the
   * sink reaches the windows and the sockets alike, and a renderer hears
   * `layout.changed` by subscription rather than by having a `webContents`.
   */
  const layoutStore = new LayoutStore(
    layoutPersistence,
    (payload) => publishRendererBroadcast("layout", "changed", payload),
    backend,
    // Which renderer is the primary window's (ADR-179 D4). Read at call time,
    // not captured: `mainWindow` is nulled on close and set again on reopen,
    // and a stale answer here would make `list_panes` describe a popout.
    (rendererId) =>
      mainWindow !== null &&
      !mainWindow.isDestroyed() &&
      !mainWindow.webContents.isDestroyed() &&
      String(mainWindow.webContents.id) === rendererId,
    // A pane's title, off the command channel (ADR-182 D1) — the same
    // `publishRendererBroadcast` sink as `layout.changed`, on its own event
    // so a renderer's replica does not have to replace itself for a title.
    (paneId, title) => publishRendererBroadcast("layout", "paneTitle", { paneId, title }),
  );
  // Before any window exists: the first thing a renderer asks for is
  // `layout.getAll()`, and a cold read of the file is not worth racing.
  layoutStore.load();
  const projectManager = new ProjectManager(backend.git);
  const themeManager = new ThemeManager();
  const portScanner = new PortScanner(backend.ports);
  const branchWatcher = new BranchWatcher();
  const diffWatcher = new DiffWatcher(backend.git);
  const githubManager = new GitHubManager();
  const linearManager = new LinearManager();

  const prewarmManager = new PrewarmManager(client, process.env.HOME || "/");
  const agentHookServer = new AgentHookServer();
  // PreferencesManager must be constructed before AgentManager so we can pass
  // the user's configured retention into the prune step.
  const preferencesManager = new PreferencesManager();
  const agentManager = new AgentManager(
    undefined,
    preferencesManager.get("agentRetentionDays"),
  );
  const keybindingsManager = new KeybindingsManager();
  // ADR-162's durable notification log. Handed to `notifications.ts` so the
  // single recording site inside `presentNotification` can reach it.
  const notificationStore = new NotificationStore();
  setNotificationStore(notificationStore);
  // ADR-168's usage stats.
  const statsStore = new StatsStore(undefined, {
    isEnabled: () => preferencesManager.get("statsEnabled"),
    onBadge: (badge) => {
      notificationStore.append({
        kind: "badge-unlocked",
        title: `Badge unlocked: ${badge.title}`,
        body: badge.description,
        target: { type: "stats" },
      });
      sendNotificationsUpdate(mainWindow);
    },
  });
  setStatsStore(statsStore);
  // A merged PR ships a workspace just as much as a quick merge does, and it
  // is the only shipping path the app never initiates itself — the PR poll is
  // where it surfaces. Counted once per PR, so a worktree kept around after
  // the merge does not keep counting (ADR-168 §2, amended 2026-09-10).
  githubManager.setPrMergedListener((prUrl) => {
    statsStore.recordOnce("prsMerged", prUrl);
  });

  // ADR-161's remote-control surface. Constructed here so the status sink and
  // the quit hook can see it; deliberately *not* started — remote control is
  // off until the user turns it on, and even then the listener is loopback-only
  // until they separately start a tunnel.
  const remoteDeviceStore = new RemoteDeviceStore();
  const remotePush = new PushManager(remoteDeviceStore);
  const remoteControlServer = new RemoteControlServer(
    (): ControlDeps => ({
      projectManager,
      githubManager,
      linearManager,
      layoutPersistence,
      layoutStore,
      agentManager,
      backend,
      notificationStore,
      statsStore,
      preferencesManager,
      themeManager,
      portScanner,
      remoteControl,
      agentHookServer,
      webviewServer,
      getRendererWindows,
    }),
    remoteDeviceStore,
    // Rate limiter, audit log, and client directory all take their defaults.
    { push: remotePush },
  );
  // Detected, never installed; started only by an explicit user action. The
  // manager is constructed here so shutdown can guarantee the child dies with
  // the app — a tunnel outliving Manor is the feature's worst failure mode.
  const remoteTunnel = new TunnelManager({
    which: async (bin) => {
      const onPath = await backend.shell.which(bin);
      if (onPath) return onPath;
      // The Tailscale app (`brew install --cask tailscale-app`, or the App
      // Store) ships its CLI inside the bundle and does not put it on PATH.
      if (bin === "tailscale" && fs.existsSync(TAILSCALE_APP_CLI)) {
        return TAILSCALE_APP_CLI;
      }
      return null;
    },
    spawn: (command, args) =>
      spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }),
    exec: (command, args) =>
      backend.shell.exec(command, args, { timeout: 5_000 }),
  });
  const remoteControl = new RemoteControlController(
    remoteControlServer,
    remoteDeviceStore,
    remoteTunnel,
    () => safeStorage.isEncryptionAvailable(),
    remotePush,
  );
  /**
   * The host surface and its two transports (ADR-180 D1/D2). Declared here
   * and built below, once `ipcDeps` exists: the handler table runs against
   * exactly that object, and the PTY forwarding below has to be able to see
   * the bridge before it is assigned.
   */
  let bridgeServer: BridgeServer | null = null;
  let wsBridge: WsBridgeServer | null = null;
  let ipcBridge: IpcBridgeTransport | null = null;

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
    agent: AgentInfo,
    prevStatus: string | null | undefined,
    newStatus: AgentStatus,
  ): void {
    _maybeSendNotification(
      agent,
      prevStatus,
      newStatus,
      mainWindow,
      preferencesManager,
    );
    // A second sink on the same transition, not a second detector: whatever
    // moves the dock badge is what a paired phone hears about. What that means
    // — a stream event, a push, or nothing at all — belongs to
    // `RemoteControlController`, not here.
    remoteControl.onAgentStatus(agent, prevStatus, newStatus, {
      notify: preferencesManager.get("notifyOnRequiresInput"),
    });
  }

  // Ensure shell integration and agent hooks are set up
  ShellManager.setupZdotdir();
  ensureHookScript();
  ensureManorCli();
  registerAllAgents();
  // The Home surface's harness runs in ~/.manor/home. Create it once here
  // instead of on every new session's launch command.
  fs.mkdirSync(homeWorkspaceDir(), { recursive: true });

  // Mutable reference to notifyAgentDetectorGone — will be set after hook relay is created
  let notifyAgentDetectorGone: ((sessionId: string) => void) | undefined;

  // Every session's output, in one place.
  //
  // The daemon client holds exactly one handler, so this is the only place a
  // stream event can be observed: a second `onEvent` would replace this one
  // rather than join it. That is why the bridge is fed from inside here — and
  // since ADR-180 ticket 5 the bridge is the *only* consumer that forwards,
  // to a renderer window and a paired device alike, each of them hearing only
  // the panes it subscribed to. `handleStreamEvent` below keeps what is left:
  // the agent bookkeeping the old per-pane sends were tangled up with.
  backend.pty.onEvent((event: StreamEvent) => {
    bridgeServer?.handleStreamEvent(event);
    // `paneSessions` is server-derived (ADR-179 D3): cwd, title and agent
    // status reach the layout file from the stream, not from a renderer
    // reporting what it saw.
    layoutStore.onPtyEvent(event);
    // One call, not one per window (ADR-180 ticket 9): `sendAgentUpdate`
    // only publishes to the bridge now, which already reaches every window
    // and every browser on its own, so the per-window loop this used to be
    // — kept alive only by the legacy `agent-updated` channel it addressed —
    // is gone with it.
    handleStreamEvent(
      event,
      agentManager,
      preferencesManager,
      notifyAgentDetectorGone,
    );
  });

  // ── Register all IPC handlers before window creation to avoid race conditions ──

  const webviewServer = webviewIpc.createWebviewServer(
    projectManager,
    githubManager,
    linearManager,
    layoutPersistence,
    agentManager,
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
    layoutStore,
    projectManager,
    themeManager,
    portScanner,
    branchWatcher,
    diffWatcher,
    githubManager,
    linearManager,
    agentHookServer,
    agentManager,
    notificationStore,
    statsStore,
    preferencesManager,
    keybindingsManager,
    paneContextMap,
    unseenRespondedAgents,
    unseenInputAgents,
    webviewServer,
    workspaceMeta: [],
    prewarmManager,
    remoteControl,
    get appMenu() {
      return appMenu;
    },
  };

  // The bridge (ADR-178 D8, ADR-180 D1). Same deps the IPC handlers get, by
  // design: one table of what this host can do, reachable two ways. The
  // surface is built here rather than inside the transport because it is the
  // thing the *next* transport attaches to as well.
  bridgeServer = new BridgeServer(ipcDeps);
  // A connection that drops has already let go of every pane it viewed
  // (`BridgeServer.drop`); whatever tab it claimed comes back to the primary
  // too (ADR-179 D4) — a claim that outlives its window is a tab no renderer
  // shows. Only a desktop window ever claims, so for a socket this is a
  // no-op.
  bridgeServer.onDisconnect((connectionId) =>
    layoutStore.releaseWindow(connectionId),
  );
  wsBridge = new WsBridgeServer(bridgeServer);
  remoteControlServer.setBridge(wsBridge);
  // The desktop's transport (D2): the same frames over `bridge:*` IPC, one
  // connection per renderer window. Started unconditionally and for the life
  // of the app — a window's first frame makes its connection, and remote
  // control being off has nothing to do with it.
  ipcBridge = new IpcBridgeTransport(ipcDeps, bridgeServer);
  ipcBridge.start();

  // Give control routes (ADR-171) the same manager bag IPC handlers have.
  webviewServer.setControlDeps({
    projectManager: ipcDeps.projectManager,
    githubManager: ipcDeps.githubManager,
    linearManager: ipcDeps.linearManager,
    layoutPersistence: ipcDeps.layoutPersistence,
    layoutStore: ipcDeps.layoutStore,
    agentManager: ipcDeps.agentManager,
    backend: ipcDeps.backend,
    notificationStore: ipcDeps.notificationStore,
    statsStore: ipcDeps.statsStore,
    preferencesManager: ipcDeps.preferencesManager,
    themeManager: ipcDeps.themeManager,
    portScanner: ipcDeps.portScanner,
    remoteControl: ipcDeps.remoteControl,
    agentHookServer: ipcDeps.agentHookServer,
    getRendererWindows: ipcDeps.getRendererWindows,
  });

  // `electron/ipc/` keeps exactly six things now (ADR-180 D8, ticket 11):
  // `webview`/`webview-keys`, `window`, `popups`, `menu` and the native
  // remnant of `misc.ts` (dialog/shell/clipboard/updater), renamed
  // `native.ts`. Everything else that used to `register()` here — layout,
  // viewport, projects, pty, theme, agents, notifications, stats, ports,
  // processes, branches/diffs, integrations, remote control — is a handler
  // table entry now, and its implementation lives under
  // `electron/bridge/handlers/`.
  webviewIpc.register(ipcDeps);
  nativeIpc.register(ipcDeps);
  windowIpc.register(ipcDeps);
  menuIpc.register(ipcDeps);
  // What is left of a few crossed namespaces' `register()` is a broadcast
  // subscription that has to run once, at boot, and was never an
  // `ipcMain.handle` — `wireStatsBroadcast`, `wirePreferencesBroadcast` and
  // `wireKeybindingsBroadcast` debounce or fan out a manager's `onChange`,
  // and `wireRemoteControlStatus` does the same for the controller.
  wireStatsBroadcast(ipcDeps);
  wirePreferencesBroadcast(ipcDeps);
  wireKeybindingsBroadcast(ipcDeps);
  wireRemoteControlStatus(ipcDeps);

  // ── App lifecycle ──
  app.whenReady().then(async () => {
    // Native application menu (ADR-170). Must run after `whenReady()` (Menu
    // isn't available before then) and before the primary window opens so the
    // menu is in place the instant the window can take focus.
    appMenu = installAppMenu({
      getMainWindow: () => mainWindow,
      getRendererWindows,
      keybindingsManager,
      checkForUpdates,
      saveZoomLevel,
    });

    // Set Dock icon on macOS
    if (process.platform === "darwin") {
      const iconPath = path.join(__dirname, "../build/dev-icon.png");
      if (fs.existsSync(iconPath)) {
        app.dock?.setIcon(nativeImage.createFromPath(iconPath));
      }
    }

    openPrimaryWindow();

    // Initialize auto-updater. It reads the primary window on each event rather
    // than capturing one — the window it started with may since have been closed
    // and replaced.
    initAutoUpdater();

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

    // Pre-warm a terminal session for instant new-agent
    prewarmManager.warm().catch(() => {});

    // Set the relay callback now that the client is connected.
    // Hook events route through the daemon's AgentDetector state machine.

    function broadcastAgent(agent: AgentInfo): void {
      sendAgentUpdate(agent, preferencesManager);
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
      agentManager,
      getPaneContext: (paneId) => paneContextMap.get(paneId),
      unseenRespondedAgents,
      unseenInputAgents,
      broadcastAgent,
      maybeSendNotification,
      onHookEvent: (event, effects, ctx) =>
        statsStore.observeHookEvent(
          event,
          effects,
          countBusyAgents(agentManager.getActiveAgents()),
          ctx.isRootSession,
        ),
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
    // The layout debounce is 300ms; a quit inside that window must not be the
    // one that loses the user's arrangement.
    layoutStore.flush();
    // Takes the tunnel down first, then the listener. A tunnel must never
    // outlive the app that opened it.
    void remoteControl.shutdown();
    // Bridge sockets die with the listener above; disposing the surface then
    // releases the renderer-broadcast and attachment sinks so nothing
    // publishes into a connection set that is gone.
    wsBridge?.dispose();
    ipcBridge?.dispose();
    bridgeServer?.dispose();
    portlessManager.stop();
    prewarmManager.dispose().catch(() => {});
    killAllActivePushes();
    statsStore.flushNow();
  });
}
