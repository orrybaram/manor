import { app, BrowserWindow, nativeImage, powerMonitor } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { layoutFile, manorDataDir } from "./paths";
import { RemoteForwards, RemoteUrlResolver } from "./remote-forwards";
import { electronSecretBox } from "./platform/electron-secret-box";
import { JevClient } from "./jev";
import { bootstrapHost } from "./terminal-host/bootstrap-host";
import { ensureManorCli } from "./manor-cli-install";
import { initAutoUpdater, checkForUpdates, setBeforeInstallHook } from "./updater";
import { portlessManager } from "./portless";
import { loginPathReady } from "./login-path";
import { LOCAL_HOST_ID } from "./backend/types";
import { HostServerSync } from "./backend/host-server-sync";
import { runHostSupervisor } from "./backend/host-supervisor";
import { HostPairingLinks } from "./remote-control/host-links";
import { PrewarmManager } from "./prewarm-manager";
import { publishRendererBroadcast, rendererBus } from "./renderer-broadcast";
import { DESKTOP_TABLE } from "./bridge/handlers";
import type { WsBridgeServer } from "./bridge/transports/ws";
import { IpcBridgeTransport } from "./bridge/transports/ipc";
import {
  RemoteControlController,
  type RemoteControlRuntime,
} from "./remote-control/controller";
import type { HostDeps } from "./ipc/types";
import { createWindow, saveZoomLevel } from "./window";
import { installAppMenu, type AppMenuController } from "./app-menu";
import { Notifier, playNotificationSound } from "./notifications";
import { wireStatsBroadcast } from "./bridge/handlers/stats";
import {
  wirePreferencesBroadcast,
  wireKeybindingsBroadcast,
} from "./bridge/handlers/preferences";
import { wireRemoteControlStatus } from "./bridge/handlers/remote-control";
import { wireHostBroadcasts } from "./bridge/handlers/hosts";
import { wireAgentActivityBroadcast } from "./bridge/handlers/agent-activity";
import { installPortEnricher } from "./bridge/handlers/ports";
import * as webviewIpc from "./ipc/webview";
import * as nativeIpc from "./ipc/native";
import * as windowIpc from "./ipc/window";
import * as menuIpc from "./ipc/menu";
import * as hostPipeIpc from "./ipc/host-pipe";
import { appCommandResult } from "./renderer-bridge";
import { createManorServer, type ManorCore } from "./server/create-manor-server";
import type { Platform } from "./server/platform";
import { stopTemplateJobs } from "./backend/providers/recipe-templates";

/** How long an agent's `navigate` waits for a remote host to come back. */
const NAVIGATE_HOST_WAIT_MS = 15_000;

/**
 * Manor's version. `app.getVersion()` in an unpackaged app launched on a bare
 * main.js (E2E, some dev setups) is Electron's own version, so read the repo's
 * package.json there instead. Remote hosts are version-matched against it.
 */
function manorVersion(): string {
  if (app.isPackaged) return app.getVersion();
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"),
    ) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version) return pkg.version;
  } catch {
    // fall through
  }
  return app.getVersion();
}

export function initApp(devTitle: string | null): void {
  // `mainWindow` is the PRIMARY renderer window. The `get mainWindow()` getter
  // on ipcDeps keeps returning it, so every existing handler is unaffected.
  let mainWindow: BrowserWindow | null = null;
  // Installed inside `app.whenReady()` below; `ipcDeps.appMenu` reads this
  // through a getter so the IPC modules can be registered before then, as
  // they are today.
  let appMenu: AppMenuController;

  // ── Window registry ────────────────────────────────────────────────────
  // All live renderer windows (primary + any detached popup windows) are
  // tracked here so stream events can be broadcast to every window that might
  // host a pane. Detached windows are additionally keyed by their windowId,
  // which is how one is reached after it was created.
  const rendererWindows = new Set<BrowserWindow>();
  const detachedWindows = new Map<string, BrowserWindow>();
  // The tab each detached window was opened to hold, by renderer id — the
  // same fact its `--manor-claim=` argument tells the page.
  const windowClaims = new Map<
    string,
    { workspacePath: string; tabId: string }
  >();

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
  let firstWindowOpened = false;
  function openPrimaryWindow(): BrowserWindow {
    const win = createWindow();
    if (!firstWindowOpened) {
      firstWindowOpened = true;
      console.log(`[startup] window created at ${Math.round(performance.now())}ms`);
      win.once("ready-to-show", () => {
        console.log(`[startup] window ready-to-show at ${Math.round(performance.now())}ms`);
      });
    }
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
   * Register a detached popup window created via `createDetachedWindow`,
   * called after creating the window so it can be reached by its windowId
   * (e.g. to deliver a one-shot detach payload) and receives broadcast events.
   */
  function registerDetachedWindow(
    windowId: string,
    win: BrowserWindow,
    claim: { workspacePath: string; tabId: string },
  ): void {
    // Read now: a closed window's `webContents` can no longer be asked.
    const rendererId = String(win.webContents.id);
    detachedWindows.set(windowId, win);
    windowClaims.set(rendererId, claim);
    trackRendererWindow(win);
    win.on("closed", () => {
      detachedWindows.delete(windowId);
      windowClaims.delete(rendererId);
    });
  }

  // ── The server ────────────────────────────────────────────
  // Everything a Manor server has wherever it runs is `createManorServer`'s;
  // what follows it here is what only the desktop has.
  // The desktop's notifier, which `createManorServer` builds through the
  // platform: the agent pipeline's banners need its full type.
  let notifier!: Notifier;
  const electronPlatform: Platform = {
    dataDir: manorDataDir(),
    layoutFile: layoutFile(),
    // The remote-control and relay modules take their platform from these ports
    // rather than importing Electron, so the host server can reuse them.
    secretBox: electronSecretBox,
    appVersion: app.getVersion(),
    // So a phone's pairings show this machine's real name.
    hostName: () => os.hostname(),
    // The process-wide sinks: the menu, the updater and the IPC transport
    // publish into them too.
    bus: rendererBus,
    notifier: (parts) =>
      (notifier = new Notifier({ ...parts, getMainWindow: () => mainWindow, getRendererWindows })),
    windows: {
      // Which renderer is the primary window's. Read at call
      // time, not captured: `mainWindow` is nulled on close and set again on
      // reopen, and a stale answer here would make `list_panes` describe a
      // popout.
      isPrimary: (rendererId) =>
        mainWindow !== null &&
        !mainWindow.isDestroyed() &&
        !mainWindow.webContents.isDestroyed() &&
        String(mainWindow.webContents.id) === rendererId,
      // The tab a detached window holds; its reports are how that takes effect.
      claimOf: (rendererId) => windowClaims.get(rendererId) ?? null,
    },
    // The diff watcher runs no git while the primary window is hidden or
    // minimized and no paired browser watches. Read at each
    // start: `mainWindow` is nulled on close and set again on reopen.
    diffWindow: () => mainWindow,
    remoteHosts: { remoteVersion: manorVersion() },
    playSound: playNotificationSound,
    appCommandResult,
  };

  /**
   * The web app's transport, built with the
   * remote-control runtime because it is only reachable through the relay
   * (and so loads lazily with it). It attaches to the same
   * bridge the desktop's windows do: one table, one connection registry,
   * two transports.
   */
  let wsBridge: WsBridgeServer | null = null;
  const loadRemoteControlRuntime = async (): Promise<RemoteControlRuntime> => {
    const [{ RelayGate }, { WsBridgeServer }, { RelayConnector }] =
      await Promise.all([
        import("./remote-control/relay-gate"),
        import("./bridge/transports/ws"),
        import("./remote-control/relay/connector"),
      ]);
    const relayIdentityStore = server.relayStores.identity;
    await relayIdentityStore.init();
    // The bridge is built synchronously during `initApp`, long before
    // anything can enable remote control. Its hello reply carries the app
    // version, so a relay page built for another version can move to the
    // matching build.
    const ws = new WsBridgeServer(server.bridge, {
      appVersion: electronPlatform.appVersion,
      hostName: electronPlatform.hostName,
    });
    wsBridge = ws;
    // The hello gate every relay channel passes: device verify,
    // failed-auth backoff, and the device's live connections for a revoke.
    const gate = new RelayGate(server.relayStores.devices, ws);
    // The relay: the only way in. Constructed, never started here —
    // only an explicit user action (via the controller) dials it.
    const relay = new RelayConnector({ identity: relayIdentityStore, gate });
    return { gate, relay, relayIdentity: relayIdentityStore };
  };

  const server = createManorServer<HostDeps>(electronPlatform, {
    table: DESKTOP_TABLE,
    onAgentStatus: (agent, prevStatus, newStatus) => {
      notifier.maybeSendNotification(agent, prevStatus, newStatus);
      // A second sink on the same transition, not a second detector: whatever
      // moves the dock badge is what a paired phone hears about. What that means
      // — a stream event, a push, or nothing at all — belongs to
      // `RemoteControlController`, not here.
      server.deps.remoteControl.onAgentStatus(agent, prevStatus, newStatus, {
        notify: server.shared.preferencesManager.get("notifyOnRequiresInput"),
      });
    },
    deps: (core) => desktopDeps(core),
  });

  /** The desktop's parts, over the server's, and the one deps object of both. */
  function desktopDeps(core: ManorCore): HostDeps {
    const { client, shared } = core;
    const { backendRegistry, portScanner } = shared;
    // Remote dev servers opened from Manor go through these.
    const remoteForwards = new RemoteForwards(backendRegistry);
    // Which host each pane's workspace lives on, and the resolver that turns a
    // URL opened in that host's context into the one to load. Built here, once,
    // so `resolvePaneUrl` below is wired into `HostDeps` before any IPC
    // module registers — no more racing a setter installed as a side effect of
    // `ports.register`.
    const paneHosts = new Map<string, string>();
    const remoteUrlResolver = new RemoteUrlResolver(portScanner, backendRegistry, remoteForwards);
    /**
     * The URL to actually load for a `navigate` in `paneId`'s webview
     * (`HostDeps.resolvePaneUrl`): itself, or rewritten through the pane's
     * host's port forward for a remote workspace. Gives up
     * (rejects) rather than wait forever on an absent host.
     */
    const resolvePaneUrl = async (paneId: string, url: string): Promise<string> => {
      const hostId = paneHosts.get(paneId);
      if (!hostId) return url;
      return remoteUrlResolver.resolve(url, hostId, NAVIGATE_HOST_WAIT_MS);
    };
    const jevClient = new JevClient({
      identityStore: async () => {
        await core.relayStores.identity.init();
        return core.relayStores.identity;
      },
    });
    const prewarmManager = new PrewarmManager(client, process.env.HOME || "/");

    // One pairing covers every host: what this desktop mints for
    // its devices on each host's server, and the revokes that follow them.
    // Built before the sync, which reconciles its lost mints on each connect;
    // it reaches the sync only once a link or revoke runs.
    const hostLinks: HostPairingLinks = new HostPairingLinks({
      devices: core.relayStores.devices,
      hostServers: () => backendRegistry.hostServers(),
      records: {
        linkPhones: (hostId) => shared.projectManager.hostLinksPhones(hostId),
        setLinkPhones: (hostId, on) => shared.projectManager.setHostLinksPhones(hostId, on),
        addPendingRevokes: (hostId, ids) =>
          shared.projectManager.addPendingHostRevokes(hostId, ids),
        label: (hostId) => shared.projectManager.hostLabel(hostId),
        pendingMints: (hostId) => shared.projectManager.pendingHostMints(hostId),
        addPendingMint: (hostId, mint) => shared.projectManager.addPendingHostMint(hostId, mint),
        clearPendingMints: (hostId, labels) =>
          shared.projectManager.clearPendingHostMints(hostId, labels),
        forgetOwed: (hostId) => shared.projectManager.forgetOwedOnHost(hostId),
        pendingRevokes: (hostId) => shared.projectManager.pendingHostRevokes(hostId),
      },
      revokePending: (hostId) => hostServerSync.revokePending(hostId),
      pairingChanged: (hostId) => {
        void hostServerSync.pairingChanged(hostId).then(() => {
          publishRendererBroadcast("hosts", "pairingChanged", hostId);
        });
      },
    });

    // Each remote host's host server signs pushes with the
    // desktop's VAPID pair, sent on every connect of the owner channel; the
    // sync also caches each host's push endpoints, which the controller below
    // reads so the desktop skips what the host server sends. The host server
    // owns its projects and layout: neither is pushed, but what
    // the desktop held for a host is handed over once.
    const hostServerSync: HostServerSync = new HostServerSync({
      registry: backendRegistry,
      // The desktop's own VAPID pair, so a phone's one browser subscription is
      // valid in every room.
      vapidKeys: () => core.relayStores.push.vapidKeys(),
      // What the desktop still holds for each host, handed to its server;
      // from then on it reads them through that server.
      adoption: core.hostAdoption,
      // The linked pairings each host is owed a revoke of.
      pendingRevokes: {
        list: (hostId) => shared.projectManager.pendingHostRevokes(hostId),
        clear: (hostId, ids) => shared.projectManager.clearPendingHostRevokes(hostId, ids),
        revoked: (hostId) => publishRendererBroadcast("hosts", "pairingChanged", hostId),
      },
      // Pairings minted on a host whose answer was lost.
      pendingMints: hostLinks.pendingMints(),
      // Linked pairings revoked on the host, or lost to a reset there.
      reconcileLinks: (hostId) => hostLinks.reconcileLinks(hostId),
      // "Keep Manor running when <host> restarts", installed on connect
      // where it is on and the host has none.
      supervision: {
        wanted: (hostId) => shared.projectManager.hostSupervised(hostId),
        install: async (hostId) => {
          const provider = backendRegistry.provider(hostId);
          if (!provider) return;
          await runHostSupervisor(provider.transport(), "install");
          publishRendererBroadcast("hosts", "pairingChanged", hostId);
        },
      },
    });
    // After the push store exists: starting syncs hosts that are already
    // connected.
    hostServerSync.start();
    hostLinks.start();

    // Remote control. Constructed here so the status sink and the
    // quit hook can see it; deliberately *not* started here — remote control is
    // off until the user turns it on (or asked for it on every launch, which
    // `startIfAsked` below honours once the app is up), and even then nothing
    // is reachable until the relay starts (there is no listener). The gate and
    // relay modules are not even loaded until then: `loadRuntime`
    // runs at most once, on the first enable.
    const remoteControl = new RemoteControlController({
      loadRuntime: loadRemoteControlRuntime,
      devices: core.relayStores.devices,
      push: core.relayStores.push,
      appVersion: electronPlatform.appVersion,
      hostPushEndpoints: (hostId) => hostServerSync.pushEndpoints(hostId),
      startOnLaunch: {
        get: () => shared.preferencesManager.get("remoteControlOnLaunch"),
        // Written through at once: an "off" lost to a quick quit would bring
        // remote control back at the next launch.
        set: (on) => {
          shared.preferencesManager.set("remoteControlOnLaunch", on);
          shared.preferencesManager.flush();
        },
      },
    });

    // Its control routes run over `ipcDeps`, which holds this server
    // and so is built just below; the first request waits on `start()`.
    const webviewServer = webviewIpc.createWebviewServer(() => ipcDeps);

    // The one deps object every host-side handler runs over — the bridge's
    // table, the IPC modules below, and the control routes.
    const ipcDeps: HostDeps = {
      ...shared,
      get mainWindow() {
        return mainWindow;
      },
      getRendererWindows,
      registerDetachedWindow,
      hostServerSync,
      ...(core.hostAdoption ? { hostAdoption: core.hostAdoption } : {}),
      hostLinks,
      remoteForwards,
      remoteUrlResolver,
      paneHosts,
      jevClient,
      webviewServer,
      // Pane inspection routes' access to WebviewServer's own pane registry
      // and console-log buffers — always itself.
      webviewPanes: webviewServer,
      resolvePaneUrl,
      workspaceMeta: [],
      prewarmManager,
      remoteControl,
      get appMenu() {
        return appMenu;
      },
    };
    return ipcDeps;
  }

  const ipcDeps = server.deps;
  const {
    backend,
    backendRegistry,
    projectManager,
    keybindingsManager,
    agentHookServer,
  } = server.shared;
  const { webviewServer, hostServerSync, hostLinks, remoteControl, prewarmManager } = ipcDeps;

  // ── Register all IPC handlers before window creation to avoid race conditions ──

  // A connection that drops has already let go of every pane it viewed
  // (`BridgeServer.drop`); whatever tab it claimed comes back to the primary
  // too — a claim that outlives its window is a tab no renderer
  // shows. Only a desktop window ever claims, so for a socket this is a
  // no-op.
  server.bridge.onDisconnect((connectionId) =>
    server.shared.layoutStore.releaseWindow(connectionId),
  );
  // The desktop's transport: the same frames over `bridge:*` IPC, one
  // connection per renderer window. Started unconditionally and for the life
  // of the app — a window's first frame makes its connection, and remote
  // control being off has nothing to do with it.
  const ipcBridge = new IpcBridgeTransport(ipcDeps, server.bridge);
  ipcBridge.start();

  // `electron/ipc/` keeps exactly six things now:
  // `webview`/`webview-keys`, `window`, `popups`, `menu` and the native
  // remnant of `misc.ts` (dialog/shell/clipboard/updater, and the terminal's
  // clipboard-image upload), renamed `native.ts`. Everything else that used
  // to `register()` here — layout, viewport, projects, pty, theme, agents,
  // agent activity, hosts, notifications, stats, ports, processes,
  // branches/diffs, integrations, remote control — is a handler table entry
  // now, and its implementation lives under `electron/bridge/handlers/`.
  webviewIpc.register(ipcDeps);
  nativeIpc.register(ipcDeps);
  windowIpc.register(ipcDeps);
  menuIpc.register(ipcDeps);
  // Each window's own streams to its hosts' servers: main
  // carries their frames between IPC and SSH, and reads none of them.
  const hostPipes = hostPipeIpc.register(ipcDeps);
  // What is left of a few crossed namespaces' `register()` is a subscription
  // that has to run once, at boot, and was never an `ipcMain.handle` — the
  // `wire*` broadcasts debounce or fan out a manager's `onChange` as a bridge
  // event, and `installPortEnricher` hands the port scanner its portless
  // dressing. The chat mirror's is the server's own (`createManorServer`).
  wireStatsBroadcast(ipcDeps);
  wireAgentActivityBroadcast(ipcDeps);
  wirePreferencesBroadcast(ipcDeps);
  wireKeybindingsBroadcast(ipcDeps);
  wireRemoteControlStatus(ipcDeps);
  wireHostBroadcasts(ipcDeps);
  installPortEnricher(ipcDeps);

  // ── App lifecycle ──
  app.whenReady().then(async () => {
    // Decrypt the secrets the stores keep in memory before any window can ask
    // for them. A store that cannot be read stays unread (and its file
    // untouched) rather than keeping the app from starting.
    await server.initSecrets();
    // Native application menu. Must run after `whenReady()` (Menu
    // isn't available before then) and before the primary window opens so the
    // menu is in place the instant the window can take focus.
    appMenu = installAppMenu({
      getMainWindow: () => mainWindow,
      getRendererWindows,
      keybindingsManager,
      checkForUpdates,
      saveZoomLevel,
    });

    // A wake from sleep or an unlock can leave a remote host's connection up
    // but wedged: the transport never closed, so nothing would
    // otherwise notice. `powerMonitor` is only available once the app is
    // ready.
    const checkRemoteHostsOnWake = (reason: "resume" | "unlock-screen"): void => {
      console.log(`[power] ${reason}: checking remote hosts`);
      backendRegistry.checkRemoteHosts();
    };
    powerMonitor.on("resume", () => checkRemoteHostsOnWake("resume"));
    powerMonitor.on("unlock-screen", () => checkRemoteHostsOnWake("unlock-screen"));

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

    // Start the local servers in parallel. Their ports must be in process.env
    // BEFORE the daemon spawns, because the daemon inherits env at spawn time
    // and passes it to PTY sessions (which need MANOR_HOOK_PORT for hook
    // scripts). `loginPathReady()` is awaited for the same reason: the daemon
    // inherits PATH at spawn. Kicked off before the sync bootstrap below so the
    // sockets can be listening while it runs. A server that fails to start is
    // logged and its port left unset; the daemon still connects without it.
    const localServers = [
      {
        name: "agent hook server",
        start: () => agentHookServer.start(),
        env: "MANOR_HOOK_PORT",
        port: () => agentHookServer.hookPort,
      },
      {
        name: "webview server",
        start: () => webviewServer.start(),
        env: "MANOR_WEBVIEW_PORT",
        port: () => webviewServer.serverPort,
      },
      {
        name: "portless proxy",
        start: () => portlessManager.start(),
        env: "MANOR_PORTLESS_PORT",
        port: () => portlessManager.proxyPort,
      },
    ];
    const serversStarted = Promise.all([
      Promise.allSettled(localServers.map((server) => server.start())),
      loginPathReady(),
    ]);

    // Ensure shell integration and agent hooks are set up — the same bootstrap
    // a remote daemon runs on its own host. A connector
    // that skips registration (e.g. a config it couldn't safely parse) is
    // reported here, not thrown — one agent's bad config must never abort
    // local startup.
    try {
      for (const warning of bootstrapHost().warnings) {
        console.warn(`[app-lifecycle] bootstrap: ${warning}`);
      }
      ensureManorCli();
    } catch (err) {
      console.error("[app-lifecycle] host bootstrap failed:", err);
    }

    const [results] = await serversStarted;
    results.forEach((result, i) => {
      const server = localServers[i];
      if (result.status === "fulfilled") {
        process.env[server.env] = String(server.port());
      } else {
        console.error(`Failed to start ${server.name}:`, result.reason);
      }
    });
    // Only remote-namespace panes set this; if Manor was launched from one,
    // local panes would otherwise send hooks to the remote daemon's listener.
    delete process.env.MANOR_HOOK_PORT_FILE;

    // Connect to daemon (spawns if needed) — now has MANOR_HOOK_PORT in env
    try {
      await backend.connect();
    } catch (err) {
      console.error("Failed to connect to terminal host daemon:", err);
    }

    // Remote hosts connect in the background — an ssh handshake and a host
    // bootstrap can take a minute, and launch must not wait for it. Only
    // hosts a project lives on; the rest connect when first used.
    for (const hostId of projectManager.remoteHostIdsInUse()) {
      if (backendRegistry.has(hostId)) backendRegistry.connectInBackground(hostId);
    }

    // Pre-warm a terminal session for instant new-agent
    prewarmManager.warm().catch(() => {});

    // The local daemon's panes may already have facts (a daemon that outlived
    // the last app run): resync them now that it is connected.
    void server.resyncHostPanes(LOCAL_HOST_ID);

    // The dock badge follows preferences from here, and hooks reach the
    // Status reconciler (`ManorServer.start`).
    server.start();

    // "Turn on when Manor opens": the one way remote control starts without a
    // click this session (see `RemoteControlController`). Not awaited — a
    // relay that is slow or down must not hold up launch; it says so in
    // the status the settings panel shows.
    remoteControl.startIfAsked().catch((err: unknown) => {
      console.error("[remote-control] start on launch failed:", err);
    });

    app.on("before-quit", () => {
      server.agentPipeline.stop();
    });

    // Reopen the PRIMARY window, not just "a" window: with a popout still open
    // the old zero-windows test never fired, so a user who closed the main
    // window could not get it back without quitting.
    app.on("activate", () => {
      // Not once a quit has begun: its IPC is gone, and a window opened now
      // would be a blank page nothing can reach.
      if (shutdownRun) return;
      if (!mainWindow || mainWindow.isDestroyed()) {
        openPrimaryWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  /**
   * The sealed stores write in the background; a quit that did not wait for
   * them would lose the last pairing or revoke. So the first quit is held
   * (`preventDefault`) while the shutdown below runs and the store queues
   * drain — at most `QUIT_FLUSH_TIMEOUT_MS` — and then quits again for real.
   * That second pass finds `shutDown` set and lets the quit through.
   */
  const QUIT_FLUSH_TIMEOUT_MS = 5_000;
  let shutDown = false;
  let shutdownRun: Promise<void> | null = null;
  /** After `before`, the store queues drained; bounded either way. */
  const flushSealedStores = async (before: Promise<unknown>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.warn("[remote-control] secret stores did not flush before quit");
        resolve();
      }, QUIT_FLUSH_TIMEOUT_MS);
    });
    const flushed = before
      .catch(() => undefined)
      .then(() =>
        Promise.all([
          server.relayStores.devices.flush(),
          server.relayStores.identity.flush(),
        ]),
      )
      .then(
        () => undefined,
        (err: unknown) => {
          console.error("[remote-control] could not persist secrets on quit:", err);
        },
      );
    await Promise.race([flushed, timeout]);
    clearTimeout(timer);
  };

  /**
   * How long after the first quit the process is ended outright if it is
   * still alive: the flush's bound, plus a margin for the quit itself.
   */
  const QUIT_BACKSTOP_MS = QUIT_FLUSH_TIMEOUT_MS + 5_000;

  /** Tears everything down once, then lets the next quit through. */
  const runShutdown = (): Promise<void> => {
    shutdownRun ??= performShutdown().finally(() => {
      shutDown = true;
    });
    return shutdownRun;
  };

  app.on("before-quit", (event) => {
    if (shutDown) return;
    event.preventDefault();
    // A second Cmd+Q while the first is still shutting down: already handled.
    if (shutdownRun) return;
    console.log("[shutdown] quit requested");
    void runShutdown().then(() => {
      console.log("[shutdown] done; quitting");
      app.quit();
    });
    // The bridge is torn down by now, so a quit that does not finish leaves
    // a window nothing answers. Whatever held it — a window refusing to
    // close, a step that never returned — the process ends anyway.
    setTimeout(() => {
      console.warn("[shutdown] quit did not complete; exiting");
      app.exit(0);
    }, QUIT_BACKSTOP_MS).unref();
  });

  // An update install quits through `before-quit` too, and re-quitting with
  // `app.quit()` after our hold could lose the relaunch. So it shuts down
  // first, and its own quit then finds `shutDown` set and passes straight
  // through, untouched.
  setBeforeInstallHook(runShutdown);

  /**
   * Run one shutdown step. A step that throws is logged and the rest still
   * run: thrown out of `before-quit`, after its `preventDefault`, it would
   * cancel the quit with half the app already torn down.
   */
  function step<T>(name: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      console.error(`[shutdown] ${name} failed:`, err);
      return undefined;
    }
  }

  function performShutdown(): Promise<void> {
    step("webview server", () => webviewServer.stop());
    step("host server sync", () => hostServerSync.dispose());
    step("host links", () => hostLinks.dispose());
    step("host pipes", () => hostPipes.dispose());
    // Takes the relay down first, then the connections it carried. Nothing
    // reachable may outlive the app that opened it.
    const remoteControlDown =
      step("remote control", () => remoteControl.shutdown()) ?? Promise.resolve();
    // Bridge sockets close with remote control above; the server's shared
    // stop then disposes the surface they attached to.
    step("ws bridge", () => wsBridge?.dispose());
    step("ipc bridge", () => ipcBridge.dispose());
    step("server", () => server.stop());
    step("portless", () => portlessManager.stop());
    step("prewarm", () => prewarmManager.dispose().catch(() => {}));
    // Background `docker pull` / `docker build` a template fix started.
    step("template jobs", () => stopTemplateJobs());
    // Last: the relay is down by now, so nothing new joins the queues.
    return flushSealedStores(remoteControlDown);
  }
}
