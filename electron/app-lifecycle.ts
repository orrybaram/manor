import { app, BrowserWindow, nativeImage, powerMonitor, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { TerminalHostClient } from "./terminal-host/client";
import { LayoutPersistence } from "./terminal-host/layout-persistence";
import { LayoutStore } from "./layout/layout-store";
import { ProjectManager } from "./persistence";
import { ThemeManager } from "./theme";
import { PortScanner } from "./ports";
import { RemoteForwards, RemoteUrlResolver } from "./remote-forwards";
import { BranchWatcher } from "./branch-watcher";
import { DiffWatcher } from "./diff-watcher";
import { GitHubManager, ghRepoFromRemoteUrl } from "./github";
import { LinearManager } from "./linear";
import { JevClient } from "./jev";
import { AgentHookServer } from "./agent-hooks";
import { NotificationCoalescer, type HookCursor } from "./backend/hook-feed";
import { bootstrapHost } from "./terminal-host/bootstrap-host";
import { createAgentStatusDriver, type AgentStatusDriver } from "./agent-status/driver";
import type { PaneStatusUpdate } from "./agent-status/effects";
import { ensureManorCli } from "./manor-cli-install";
import { AgentManager, agentHostId, type AgentInfo } from "./agent-persistence";
import { ChatMirror, pickPaneAgent } from "./chat-mirror/mirror";
import { LocalTranscriptSource } from "./chat-mirror/transcript-source";
import { NotificationStore } from "./notification-store";
import { StatsStore } from "./stats-store";
import { createWorkspaceOps } from "./workspace-ops";
import { AgentActivityStore } from "./agent-activity-store";
import { countBusyAgents } from "./stats-signals";
import { PreferencesManager } from "./preferences";
import { KeybindingsManager } from "./keybindings";
import { cleanAgentTitle } from "./title-utils";
import type { AgentStatus, StreamEvent } from "./terminal-host/types";
import { initAutoUpdater, checkForUpdates } from "./updater";
import { portlessManager } from "./portless";
import { loginPathReady } from "./login-path";
import { createLocalBackend } from "./backend/host-backend";
import { LOCAL_HOST_ID } from "./backend/types";
import {
  BackendRegistry,
  isRemoteSessionLoss,
  type HostStatus,
} from "./backend/registry";
import { RoutedBackend } from "./backend/routed-backend";
import { PrewarmManager } from "./prewarm-manager";
import { publishRendererBroadcast } from "./renderer-broadcast";
import { RemoteDeviceStore } from "./remote-control/devices";
import { BridgeServer } from "./bridge/server";
import type { WsBridgeServer } from "./bridge/transports/ws";
import { IpcBridgeTransport } from "./bridge/transports/ipc";
import {
  RemoteControlController,
  type RemoteControlRuntime,
} from "./remote-control/controller";
import { PushManager } from "./remote-control/push";
import type { HostDeps } from "./ipc/types";
import { handleRelayedControlRequest } from "./control-relay";
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
import { createAgentService } from "./bridge/handlers/agents";
import { wireStatsBroadcast } from "./bridge/handlers/stats";
import {
  wirePreferencesBroadcast,
  wireKeybindingsBroadcast,
} from "./bridge/handlers/preferences";
import { wireRemoteControlStatus } from "./bridge/handlers/remote-control";
import { wireHostBroadcasts } from "./bridge/handlers/hosts";
import { wireAgentActivityBroadcast } from "./bridge/handlers/agent-activity";
import { wireChatMirror } from "./bridge/handlers/chat";
import { installPortEnricher } from "./bridge/handlers/ports";
import * as webviewIpc from "./ipc/webview";
import * as nativeIpc from "./ipc/native";
import * as windowIpc from "./ipc/window";
import * as menuIpc from "./ipc/menu";
import { notifyProjectsChanged, runSetupScript } from "./renderer-bridge";
import { RemoteWorktreePoller, WorktreeWatcher } from "./projects/worktree-watcher";

/** How long an agent's `navigate` waits for a remote host to come back. */
const NAVIGATE_HOST_WAIT_MS = 15_000;

/**
 * How long the one-time layout.json key migration (ADR-191) waits for a
 * remote host to say where its worktrees live. It holds up the first
 * `layout.getAll()` after the upgrade, so it is kept short: a host that misses
 * it is still matched by its project root and remembered workspace paths.
 */
const LAYOUT_MIGRATION_HOST_WAIT_MS = 5_000;

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

export interface AgentStreamDeps {
  agentManager: Pick<AgentManager, "getAgentByPaneId" | "updateAgent">;
  agentStatus: Pick<AgentStatusDriver, "signal" | "noteOutput" | "forgetPane">;
  /** Broadcast an updated Agent (and refresh the dock badge). */
  broadcastAgent: (agent: AgentInfo) => void;
}

/**
 * The agent-domain side of a stream event, run ONCE per event in main
 * (ADR-184):
 * - `paneFacts` → a Status signal for the pane, and the Agent's name from the
 *   terminal title (unless the user pinned one);
 * - `cwd` → the active Agent's cwd;
 * - `data` → the pane is still drawing (throttled in the driver), which keeps
 *   a long streamed reply from reading as a stuck turn;
 * - `exit` → the pane's reconciler state is dropped.
 */
export function handleAgentStreamEvent(event: StreamEvent, deps: AgentStreamDeps): void {
  try {
    switch (event.type) {
      case "paneFacts": {
        deps.agentStatus.signal(event.sessionId, { type: "paneFacts", facts: event.facts });
        // Update the persisted Agent name from the terminal title — unless the
        // user pinned a name of their own, which the title sync must not
        // clobber. Only an agent still running in the foreground names
        // itself: once it exits, the title is the shell's, and a finished
        // Agent keeps the name it ended with.
        const cleaned = event.facts.foreground?.kind ? cleanAgentTitle(event.facts.title) : null;
        if (cleaned) {
          const agent = deps.agentManager.getAgentByPaneId(event.sessionId);
          if (agent && agent.status === "active" && !agent.namePinned && agent.name !== cleaned) {
            const updated = deps.agentManager.updateAgent(agent.id, { name: cleaned });
            if (updated) deps.broadcastAgent(updated);
          }
        }
        break;
      }
      case "cwd": {
        // Update the agent's cwd if it is active and differs.
        const agent = deps.agentManager.getAgentByPaneId(event.sessionId);
        if (agent && agent.status === "active" && agent.cwd !== event.cwd) {
          const updated = deps.agentManager.updateAgent(agent.id, { cwd: event.cwd });
          if (updated) deps.broadcastAgent(updated);
        }
        break;
      }
      case "data":
        deps.agentStatus.noteOutput(event.sessionId);
        break;
      case "exit":
        deps.agentStatus.forgetPane(event.sessionId);
        break;
    }
  } catch (err) {
    console.error("Error in agent stream event handler:", err);
  }
}

/**
 * What main does with one stream event from any host: its agent side once
 * (`handleAgentStreamEvent`), then the pane events to every renderer, once.
 *
 * `forward` is the bridge (`BridgeServer.handleStreamEvent`, ADR-180 D5): a
 * pane's output, exit, cwd, resize and error used to go out on a
 * `pty-${kind}-${paneId}` channel to every live window, whether or not it had
 * the pane; they are `pty.*` event frames now, keyed by paneId, published to
 * windows and devices alike — each hearing only the panes it subscribed to.
 * However many renderers are attached, a signal reaches the Status
 * reconciler once and its effects are applied once (ADR-184). `paneFacts`
 * never reaches a renderer.
 */
export function dispatchStreamEvent(
  event: StreamEvent,
  agentDeps: AgentStreamDeps,
  forward: (event: StreamEvent) => void,
): void {
  handleAgentStreamEvent(event, agentDeps);
  if (event.type === "paneFacts") return;
  try {
    forward(event);
  } catch (err) {
    console.error("Error forwarding stream event:", err);
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
  // The tab each detached window was opened to hold, by renderer id — the
  // same fact its `--manor-claim=` argument tells the page (ADR-179 D4).
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

  // Managers
  // The local daemon is handshaken against Electron's version. A stale daemon
  // it replaces reports the sessions it is about to kill through the
  // registry, like a remote host's (ADR-185 §A); only ever called from
  // `connect()`, long after `backendRegistry` exists.
  const client = new TerminalHostClient(app.getVersion(), undefined, (sessionIds) =>
    backendRegistry.reportDaemonReplacing(LOCAL_HOST_ID, sessionIds),
  );
  // Every host's backend, "local" always among them (ADR-160 §6). Remote
  // hosts come from projects.json below and connect lazily, off the launch
  // path; with none registered everything routes to the local backend.
  const backendRegistry = new BackendRegistry({
    local: createLocalBackend(client),
    remoteVersion: manorVersion(),
    // Where each remote host's hook journal was read up to (ADR-178 §2).
    // Only read once hosts are registered, after projectManager exists.
    hookSeqStore: {
      get: (hostId): HookCursor | null => projectManager.getHostHookCursor(hostId),
      set: (hostId, cursor): void => projectManager.setHostHookCursor(hostId, cursor),
    },
  });
  const layoutPersistence = new LayoutPersistence();
  // Each project's git, shell and machine facts come from its host (ADR-183).
  // A remote project keeps its last workspace listing only while its host
  // is away (ADR-192 §5).
  const projectManager = new ProjectManager((hostId) => backendRegistry.get(hostId), undefined, {
    isHostAway: (hostId) => backendRegistry.status(hostId) !== "connected",
    // Removing a worktree or a project tears its layout down first (ADR-182
    // D7), whichever caller — sidebar, quick merge, CLI or MCP — asked for it.
    // Read at call time: the store is built just below.
    layout: { remove: (key) => layoutStore.remove(key) },
  });
  for (const { hostId, spec } of projectManager.getHosts()) {
    backendRegistry.register(hostId, spec);
  }
  // layout.json keyed its workspaces by bare path before ADR-191. Rekey it
  // once by host plus path, off the launch path; the layout store waits for it.
  void layoutPersistence.startWorkspaceKeyMigration(() =>
    projectManager.workspaceKeyOwners(LAYOUT_MIGRATION_HOST_WAIT_MS),
  );
  // Worktrees made or removed outside Manor (an agent's `git worktree add`)
  // never pass through a route that notifies the renderer; watch for them.
  const worktreeWatcher = new WorktreeWatcher(notifyProjectsChanged);
  const remoteWorktreePoller = new RemoteWorktreePoller(backendRegistry, notifyProjectsChanged);
  const syncWorktreeWatchers = () => {
    worktreeWatcher.sync(projectManager.localProjectPaths());
    remoteWorktreePoller.sync(projectManager.remoteProjectHostPaths());
  };
  syncWorktreeWatchers();
  projectManager.onStateSaved(syncWorktreeWatchers);
  // The one backend IPC handlers and control routes see: routes each pane,
  // cwd and pid to the host that owns it. A bare cwd is the only thing whose
  // host is inferred from its path (ADR-183); the pollers below are handed
  // each workspace's host instead.
  const backend = new RoutedBackend(
    backendRegistry,
    (p) => projectManager.hostIdForPath(p),
    (pid) => portScanner.hostsListeningOn(pid),
  );
  /**
   * ADR-179: layout is the Manor server's, not a renderer's. One broadcaster
   * feeds every audience from the one place the layout changes.
   *
   * A desktop window is a bridge connection, so the sink reaches the windows
   * and the sockets alike, and a renderer hears `layout.changed` by
   * subscription rather than by having a `webContents`.
   */
  const layoutStore = new LayoutStore(
    layoutPersistence,
    (payload) => publishRendererBroadcast("layout", "changed", payload),
    backend,
    {
      // Which renderer is the primary window's (ADR-179 D4). Read at call
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
    // A pane's title, off the command channel (ADR-182 D1) — the same
    // `publishRendererBroadcast` sink as `layout.changed`, on its own event
    // so a renderer's replica does not have to replace itself for a title.
    (paneId, title) =>
      publishRendererBroadcast("layout", "paneTitle", { paneId, title }),
    // Every pane the store ends takes its agent with it (ADR-182 D7) — the
    // one abandonment for every close path, a removed workspace, and a
    // legacy Home entry dropped on load. Read at call time: the agent side
    // is built below.
    {
      abandonForPanes: (panes) => agentService.abandonForPanes(panes),
    },
  );
  // Read the file once its workspace-key migration (above) has settled —
  // usually at once; `layout.getAll()` and every command wait for it, so a
  // renderer only ever sees host-qualified keys.
  void layoutStore.startLoad(layoutPersistence.whenReady());
  const themeManager = new ThemeManager();
  const portScanner = new PortScanner(backendRegistry);
  // Remote dev servers opened from Manor go through these (ADR-178 §5).
  const remoteForwards = new RemoteForwards(backendRegistry);
  // Which host each pane's workspace lives on, and the resolver that turns a
  // URL opened in that host's context into the one to load. Built here, once,
  // so `resolvePaneUrl` below is wired into `HostDeps` before any IPC
  // module registers — no more racing a setter installed as a side effect of
  // `ports.register` (ADR-183).
  const paneHosts = new Map<string, string>();
  const remoteUrlResolver = new RemoteUrlResolver(portScanner, backendRegistry, remoteForwards);
  /**
   * The URL to actually load for a `navigate` in `paneId`'s webview
   * (`HostDeps.resolvePaneUrl`): itself, or rewritten through the pane's
   * host's port forward for a remote workspace (ADR-178 §5). Gives up
   * (rejects) rather than wait forever on an absent host.
   */
  const resolvePaneUrl = async (paneId: string, url: string): Promise<string> => {
    const hostId = paneHosts.get(paneId);
    if (!hostId) return url;
    return remoteUrlResolver.resolve(url, hostId, NAVIGATE_HOST_WAIT_MS);
  };
  const branchWatcher = new BranchWatcher(backendRegistry);
  // Paused while the desktop window is hidden — unless a paired browser is
  // subscribed to the diff events (read at scan time: the bridge is built
  // below).
  const diffWatcher = new DiffWatcher(
    backendRegistry,
    () =>
      (bridgeServer?.hasDeviceSubscriber("diffs", "changed") ?? false) ||
      (bridgeServer?.hasDeviceSubscriber("diffs", "fingerprintsChange") ??
        false),
  );
  // `gh` runs here, where it is authenticated; a remote project's checkout
  // isn't, so it is told the repo from that checkout's origin instead, read
  // on the host the caller named (ADR-191).
  const githubManager = new GitHubManager(async (hostId, repoPath) => {
    const origin = (
      await backendRegistry.get(hostId).git.exec(repoPath, ["remote", "get-url", "origin"])
    ).trim();
    const repo = ghRepoFromRemoteUrl(origin);
    if (!repo) throw new Error(`Not a GitHub remote: ${origin}`);
    return repo;
  });
  const linearManager = new LinearManager();
  const jevClient = new JevClient();

  const prewarmManager = new PrewarmManager(client, process.env.HOME || "/");
  const agentHookServer = new AgentHookServer();
  // Remote hosts' hooks take the same path as local ones (ADR-178 §2).
  // Replayed hooks hold their notifications until the catch-up finishes, so
  // a night's worth of hooks is one banner per agent, not hundreds.
  const notificationCoalescer = new NotificationCoalescer(maybeSendNotification);
  backendRegistry.setHookSink({
    ingest: (payload, { hostId, replay }) => {
      const ingest = () => agentHookServer.ingestHookPayload(payload, { hostId });
      if (replay) notificationCoalescer.hold(hostId, ingest);
      else ingest();
    },
    replayFinished: (hostId) => notificationCoalescer.flush(hostId),
  });
  // PreferencesManager must be constructed before AgentManager so we can pass
  // the user's configured retention into the prune step.
  const preferencesManager = new PreferencesManager();
  // An agent saved before ADR-191 has no host: it takes its project's.
  const agentManager = new AgentManager(
    undefined,
    preferencesManager.get("agentRetentionDays"),
    (projectId) => projectManager.getProjectHostId(projectId),
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
        target: { type: "stats", badgeId: badge.id },
      });
      sendNotificationsUpdate();
    },
  });
  setStatsStore(statsStore);
  // ADR-203: one workspace lifecycle for both IPC and the control routes, so
  // stats, last-used host and the broadcast happen whichever transport asked.
  const workspaceOps = createWorkspaceOps({
    projectManager,
    statsStore,
    notifyProjectsChanged,
    runSetupScript,
  });
  // ADR-199's persistent Agent activity history, fed by `publishPaneStatus`.
  const agentActivityStore = new AgentActivityStore();
  // A merged PR ships a workspace just as much as a quick merge does, and it
  // is the only shipping path the app never initiates itself — the PR poll is
  // where it surfaces. Counted once per PR, so a worktree kept around after
  // the merge does not keep counting (ADR-168 §2, amended 2026-09-10).
  githubManager.setPrMergedListener((prUrl) => {
    statsStore.recordOnce("prsMerged", prUrl);
  });

  // ADR-161's remote control. Constructed here so the status sink and the
  // quit hook can see it; deliberately *not* started — remote control is off
  // until the user turns it on, and even then nothing is reachable until they
  // separately start the relay (ADR-207: there is no listener). The gate and
  // relay modules are not even loaded until then (ADR-205 §3): `loadRuntime`
  // runs at most once, on the first enable.
  const remoteDeviceStore = new RemoteDeviceStore();
  const remotePush = new PushManager(remoteDeviceStore);
  /**
   * The host surface and its two transports (ADR-180 D1/D2). The surface and
   * the desktop's IPC transport are built below, once `ipcDeps` exists: the
   * handler table runs against exactly that object, and the PTY forwarding
   * below has to be able to see the bridge before it is assigned.
   *
   * The socket transport — the web app's way in — is built with the
   * remote-control runtime instead, because it is only reachable through the
   * relay (and so loads lazily with it, ADR-205 §3). It attaches to the
   * same `bridgeServer` the desktop's windows do: one table, one connection
   * registry, two transports.
   */
  let bridgeServer: BridgeServer | null = null;
  let wsBridge: WsBridgeServer | null = null;
  let ipcBridge: IpcBridgeTransport | null = null;
  const loadRemoteControlRuntime = async (): Promise<RemoteControlRuntime> => {
    const [
      { RelayGate },
      { WsBridgeServer },
      { RelayConnector },
      { RelayIdentityStore },
    ] = await Promise.all([
      import("./remote-control/relay-gate"),
      import("./bridge/transports/ws"),
      import("./remote-control/relay/connector"),
      import("./remote-control/relay/identity"),
    ]);
    // The web app's transport (ADR-178 D8, ADR-180 D1). `bridgeServer` is
    // built synchronously during `initApp`, long before anything can enable
    // remote control. Its hello reply carries the app version, so a relay
    // page built for another version can move to the matching build
    // (ADR-206 D4).
    const ws = new WsBridgeServer(bridgeServer!, {
      appVersion: app.getVersion(),
    });
    wsBridge = ws;
    // The hello gate every relay channel passes (ADR-207 D3): device verify,
    // failed-auth backoff, and the device's live connections for a revoke.
    const gate = new RelayGate(remoteDeviceStore, ws);
    // ADR-206's relay: the only way in. Constructed, never started here —
    // only an explicit user action (via the controller) dials it.
    const relayIdentity = new RelayIdentityStore();
    const relay = new RelayConnector({ identity: relayIdentity, gate });
    return { gate, relay, relayIdentity };
  };
  const remoteControl = new RemoteControlController(
    loadRemoteControlRuntime,
    remoteDeviceStore,
    () => safeStorage.isEncryptionAvailable(),
    remotePush,
    app.getVersion(),
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

  function broadcastAgent(agent: AgentInfo): void {
    sendAgentUpdate(agent, preferencesManager);
  }

  // ── Agent status (ADR-184) ─────────────────────────────────────────────
  // The Status reconciler's driver: the one decider of every pane's Agent
  // status, and the only writer of Agents' lifecycle and last status. Built
  // before the IPC handlers and routes that feed it user signals.

  /** A pane's session owner: the host its terminal runs on (ADR-191 §5). */
  const getPaneHostId = (paneId: string) => backendRegistry.sessions.ownerOf(paneId);

  const agentStatusDriver: AgentStatusDriver = createAgentStatusDriver({
    agentManager,
    getPaneContext: (paneId) => paneContextMap.get(paneId),
    getPaneHostId,
    unseenRespondedAgents,
    unseenInputAgents,
    broadcastAgent,
    // Replayed remote hooks hold their notifications (ADR-178 §2).
    maybeSendNotification: (agent, prevStatus, newStatus) =>
      notificationCoalescer.send(agent, prevStatus, newStatus),
    publishPaneStatus: (update: PaneStatusUpdate) => {
      // One event, every renderer — windows and browsers alike — once per
      // signal (ADR-184 §4, ADR-180 D5): `agents.onStatus`.
      publishRendererBroadcast("agents", "status", update);
      // Server-derived `paneSessions` (ADR-179 D3): the last status reaches
      // the layout file for a cold restore to show.
      layoutStore.onPaneStatus(update);
      // Recorded per Agent, not per pane: panes are ephemeral (ADR-199 §1).
      // A pane with no Agent has no lane to record into. The lookup waits for
      // the rest of this effect batch: the reconciler publishes before its
      // `CreateAgent`, so a new Agent's first status would otherwise find no
      // Agent — or the retiring one — on the pane.
      const at = Date.now();
      queueMicrotask(() => {
        const agent = agentManager.getAgentByPaneId(update.paneId);
        if (agent) agentActivityStore.record(agent, update.status, at);
      });
    },
    onHookEvent: (event, effects, { isRootSession, replacedRootSessionId }) => {
      statsStore.observeHookEvent(
        event,
        effects,
        countBusyAgents(agentManager.getActiveAgents()),
        isRootSession,
        replacedRootSessionId,
      );
    },
  });

  // The agents side of a pane leaving a tree (ADR-182 D7): the store calls it
  // for every pane it ends, and the abandonment is a `user` signal to the
  // Status reconciler like any other close (ADR-184).
  const agentService = createAgentService({
    agentManager,
    statsStore,
    preferencesManager,
    agentStatus: agentStatusDriver,
  });

  /**
   * Resync a host's panes after it (re)connects: the `paneFacts` stream has
   * nothing to replay, so ask for each live session's current facts. Without
   * `sessionIds`, every session the host has now.
   */
  async function resyncPaneFacts(hostId: string, sessionIds?: readonly string[]): Promise<void> {
    try {
      const pty = backendRegistry.get(hostId).pty;
      const ids = sessionIds ?? (await pty.listSessions()).map((s) => s.sessionId);
      await agentStatusDriver.resync(ids, (id) => pty.getPaneFacts(id));
    } catch (err) {
      console.debug(`[agent-status] resync of ${hostId} failed:`, err);
    }
  }

  // A daemon about to be replaced (local or remote) kills every pty on it.
  // Those Agents did not finish: their SessionEnd must not complete them, so
  // the renderer's cold restore resumes them (ADR-185 §A). Subscribed before
  // any `connect()` (the event fires inside it); a SessionEnd the hook server
  // hears before `setRelay` below is queued and replayed after, still inside
  // the window.
  backendRegistry.onDaemonReplacing((_hostId, sessionIds) => {
    agentStatusDriver.expectPaneLoss(sessionIds);
  });

  // The local daemon's reconnects (its client's supervisor)...
  client.setConnectionListener({
    onReconnected: ({ sessionIds }) => void resyncPaneFacts(LOCAL_HOST_ID, sessionIds),
  });
  // ...and remote hosts' (their `hostReconnected` carries the survivors).
  backendRegistry.onHostEvent((hostId, event) => {
    if (event.type === "hostReconnected") void resyncPaneFacts(hostId, event.sessionIds);
  });

  // Every session's output, in one place. Events arrive tagged with their
  // host. The registry has already used the
  // tag to record which host owns the session (so pane calls route back to
  // it) and dropped any event for a session another host owns; the pane
  // channels themselves stay keyed by pane id, which is unique across hosts.
  // The renderer's project list is fetched before a remote host connects, so
  // its workspaces fall back to the main path until the next `getProjects()`.
  // Tell it to refetch the moment any host reaches "connected" rather than
  // waiting on some unrelated mutation to trigger it (ADR-160 ticket 9
  // follow-up).
  const lastHostStatus = new Map<string, HostStatus>();
  backendRegistry.onStatusChange((hosts) => {
    for (const host of hosts) {
      const prev = lastHostStatus.get(host.hostId);
      lastHostStatus.set(host.hostId, host.status);
      if (host.status === "connected" && prev !== "connected") {
        notifyProjectsChanged();
        // A remote host's first connect (a reconnect is `hostReconnected`'s):
        // its panes' facts may already say something (ADR-184).
        if (host.hostId !== LOCAL_HOST_ID && prev !== "reconnecting") {
          void resyncPaneFacts(host.hostId);
        }
      }
    }
  });

  // ADR-215: each pane's Claude transcript, for the phone's chat view. It
  // publishes through the bridge, which is built below; nothing is published
  // before somebody subscribes, and nobody can before the bridge exists.
  const localTranscriptSource = new LocalTranscriptSource();
  const chatMirror = new ChatMirror({
    agentForPane: (paneId) => {
      const agent = pickPaneAgent(agentManager.getAllAgents(), paneId);
      if (!agent) return null;
      return {
        hostId: agentHostId(agent, getPaneHostId),
        transcriptPath: agent.transcriptPath,
      };
    },
    sourceFor: () => localTranscriptSource,
    write: (paneId, data) => backend.pty.write(paneId, data),
    publish: (paneId, entry) =>
      bridgeServer?.publishKeyed("chat", "entry", [paneId, entry], paneId),
  });

  backendRegistry.onEvent((hostId: string, event: StreamEvent) => {
    // A remote pane whose session a daemon restart took is not closed like
    // one whose shell exited: the renderer recovers it when the host's
    // `hosts:reconnected` arrives (ADR-178 §6).
    if (isRemoteSessionLoss(hostId, event)) return;
    // `paneSessions` is server-derived (ADR-179 D3): cwd and title reach the
    // layout file from the stream, not from a renderer reporting what it saw.
    layoutStore.onPtyEvent(event);
    // A pane's shell is gone: its transcript watcher goes with it (ADR-215).
    if (event.type === "exit") chatMirror.closePane(event.sessionId);
    // Every host's stream events arrive here and only here, so this is where
    // the bridge is fed (ADR-180 D5) — the only consumer that forwards, to a
    // renderer window and a paired device alike.
    dispatchStreamEvent(
      event,
      { agentManager, agentStatus: agentStatusDriver, broadcastAgent },
      (e) => bridgeServer?.handleStreamEvent(e),
    );
  });

  // ── Register all IPC handlers before window creation to avoid race conditions ──

  // Its control routes (ADR-171) run over `ipcDeps`, which holds this server
  // and so is built just below; the first request waits on `start()`.
  const webviewServer = webviewIpc.createWebviewServer(() => ipcDeps);

  // The one deps object every host-side handler runs over — the bridge's
  // table, the IPC modules below, and the control routes (ADR-182 D8).
  const ipcDeps: HostDeps = {
    get mainWindow() {
      return mainWindow;
    },
    getRendererWindows,
    registerDetachedWindow,
    backend,
    backendRegistry,
    getPaneHostId,
    layoutPersistence,
    layoutStore,
    projectManager,
    themeManager,
    portScanner,
    remoteForwards,
    remoteUrlResolver,
    paneHosts,
    branchWatcher,
    diffWatcher,
    githubManager,
    linearManager,
    jevClient,
    agentHookServer,
    agentManager,
    agentStatus: agentStatusDriver,
    chatMirror,
    notificationStore,
    statsStore,
    workspaceOps,
    agentActivityStore,
    preferencesManager,
    keybindingsManager,
    paneContextMap,
    unseenRespondedAgents,
    unseenInputAgents,
    webviewServer,
    // Pane inspection routes' access to WebviewServer's own pane registry
    // and console-log buffers (ADR-183) — always itself.
    webviewPanes: webviewServer,
    resolvePaneUrl,
    sessionOwners: backendRegistry.sessions,
    hostStatus: (hostId) => backendRegistry.status(hostId),
    workspaceMeta: [],
    prewarmManager,
    remoteControl,
    get appMenu() {
      return appMenu;
    },
  };


  // Remote hosts' `manor` CLIs reach the same routes, with the same deps,
  // behind the remote allowlist (ADR-189 §2). Set once those deps exist; a
  // request relayed before then is answered 503.
  backendRegistry.setControlRelaySink((hostId, req) =>
    handleRelayedControlRequest(webviewServer.getDeps(), hostId, req),
  );

  // The bridge (ADR-178 D8, ADR-180 D1). Same deps the native IPC modules
  // get, by design: one table of what this host can do. The surface is built
  // here rather than inside a transport because it is the thing every
  // transport attaches to.
  bridgeServer = new BridgeServer(ipcDeps);
  // A connection that drops has already let go of every pane it viewed
  // (`BridgeServer.drop`); whatever tab it claimed comes back to the primary
  // too (ADR-179 D4) — a claim that outlives its window is a tab no renderer
  // shows. Only a desktop window ever claims, so for a socket this is a
  // no-op.
  bridgeServer.onDisconnect((connectionId) =>
    layoutStore.releaseWindow(connectionId),
  );
  // The desktop's transport (D2): the same frames over `bridge:*` IPC, one
  // connection per renderer window. Started unconditionally and for the life
  // of the app — a window's first frame makes its connection, and remote
  // control being off has nothing to do with it.
  ipcBridge = new IpcBridgeTransport(ipcDeps, bridgeServer);
  ipcBridge.start();

  // `electron/ipc/` keeps exactly six things now (ADR-180 D8, ticket 11):
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
  // What is left of a few crossed namespaces' `register()` is a subscription
  // that has to run once, at boot, and was never an `ipcMain.handle` — the
  // `wire*` broadcasts debounce or fan out a manager's `onChange` as a bridge
  // event, and `installPortEnricher` hands the port scanner its portless
  // dressing.
  wireStatsBroadcast(ipcDeps);
  wireAgentActivityBroadcast(ipcDeps);
  wireChatMirror(ipcDeps, bridgeServer);
  wirePreferencesBroadcast(ipcDeps);
  wireKeybindingsBroadcast(ipcDeps);
  wireRemoteControlStatus(ipcDeps);
  wireHostBroadcasts(ipcDeps);
  installPortEnricher(ipcDeps);

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

    // A wake from sleep or an unlock can leave a remote host's connection up
    // but wedged (ADR-188 §3): the transport never closed, so nothing would
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
    // a remote daemon runs on its own host (ADR-160 ticket 10). A connector
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
    // the last app run): resync them now that it is connected (ADR-184).
    void resyncPaneFacts(LOCAL_HOST_ID);

    // Update dock badge whenever preferences change (e.g. user toggles dockBadgeEnabled)
    preferencesManager.onChange(() => {
      updateDockBadge();
    });

    // Every hook — local HTTP and remote hook-feed replay alike, through
    // `ingestHookPayload` — is a Status signal for the reconciler (ADR-184).
    // The daemon's AgentDetector no longer hears about hooks.
    agentHookServer.setRelay((event) => {
      agentStatusDriver.hook(event);
    });

    // One tick, on the old sweep cadence, carries every time-based rule.
    agentStatusDriver.start();

    app.on("before-quit", () => {
      agentStatusDriver.stop();
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

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    agentHookServer.stop();
    webviewServer.stop();
    // The layout debounce is 300ms; a quit inside that window must not be the
    // one that loses the user's arrangement.
    layoutStore.flush();
    // Takes the relay down first, then the connections it carried. Nothing
    // reachable may outlive the app that opened it.
    void remoteControl.shutdown();
    // Bridge sockets close with remote control above; disposing the surface then
    // releases the renderer-broadcast and attachment sinks so nothing
    // publishes into a connection set that is gone.
    wsBridge?.dispose();
    ipcBridge?.dispose();
    bridgeServer?.dispose();
    chatMirror.dispose();
    portlessManager.stop();
    prewarmManager.dispose().catch(() => {});
    // Takes down the ssh children; remote sessions keep running on their hosts.
    void backendRegistry.disconnectAll();
    killAllActivePushes();
    statsStore.flushNow();
    agentActivityStore.flush();
    agentActivityStore.dispose();
    projectManager.flushHostHookSeqs();
    worktreeWatcher.dispose();
    remoteWorktreePoller.dispose();
  });
}
