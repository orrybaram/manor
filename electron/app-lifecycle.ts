import { app, BrowserWindow, nativeImage, powerMonitor, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { TerminalHostClient } from "./terminal-host/client";
import { LayoutPersistence } from "./terminal-host/layout-persistence";
import { ProjectManager } from "./persistence";
import { ThemeManager } from "./theme";
import { PortScanner } from "./ports";
import { RemoteForwards, RemoteUrlResolver } from "./remote-forwards";
import { BranchWatcher } from "./branch-watcher";
import { DiffWatcher } from "./diff-watcher";
import { GitHubManager, ghRepoFromRemoteUrl } from "./github";
import { LinearManager } from "./linear";
import { homeWorkspaceDir } from "./paths";
import { AgentHookServer } from "./agent-hooks";
import { NotificationCoalescer, type HookCursor } from "./backend/hook-feed";
import { bootstrapHost } from "./terminal-host/bootstrap-host";
import { createAgentStatusDriver, type AgentStatusDriver } from "./agent-status/driver";
import type { PaneStatusUpdate } from "./agent-status/effects";
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
import { createLocalBackend } from "./backend/host-backend";
import { LOCAL_HOST_ID } from "./backend/types";
import {
  BackendRegistry,
  isRemoteSessionLoss,
  type HostStatus,
} from "./backend/registry";
import { RoutedBackend } from "./backend/routed-backend";
import { PrewarmManager } from "./prewarm-manager";
import { RemoteDeviceStore } from "./remote-control/devices";
import { RemoteControlServer } from "./remote-control/server";
import { TunnelManager } from "./remote-control/tunnel";
import { RemoteControlController } from "./remote-control/controller";
import { PushManager } from "./remote-control/push";
import type { ControlDeps } from "./routes/types";
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
import * as ptyIpc from "./ipc/pty";
import * as layoutIpc from "./ipc/layout";
import * as projectsIpc from "./ipc/projects";
import * as themeIpc from "./ipc/theme";
import * as portsIpc from "./ipc/ports";
import * as branchesDiffsIpc from "./ipc/branches-diffs";
import { killAllActivePushes } from "./ipc/branches-diffs";
import * as integrationsIpc from "./ipc/integrations";
import * as webviewIpc from "./ipc/webview";
import * as agentsIpc from "./ipc/agents";
import * as notificationsIpc from "./ipc/notifications";
import * as statsIpc from "./ipc/stats";
import * as miscIpc from "./ipc/misc";
import * as processesIpc from "./ipc/processes";
import * as windowIpc from "./ipc/window";
import * as remoteControlIpc from "./ipc/remote-control";
import * as menuIpc from "./ipc/menu";
import * as hostsIpc from "./ipc/hosts";
import { notifyProjectsChanged } from "./renderer-bridge";
import { RemoteWorktreePoller, WorktreeWatcher } from "./projects/worktree-watcher";

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

// Extract stream event handler for testability.
//
// Runs once per renderer window, so it only forwards pane channels. Anything
// agent-related lives in `handleAgentStreamEvent`, which main runs once per
// event (ADR-184).
export function handleStreamEvent(event: StreamEvent, window: BrowserWindow): void {
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
      case "resized":
        // Forwarded on the same channel ordering as output, because where it
        // sits among the data events is the whole content of the message.
        window.webContents.send(
          `pty-resized-${event.sessionId}`,
          event.cols,
          event.rows,
        );
        break;
      case "cwd":
        window.webContents.send(`pty-cwd-${event.sessionId}`, event.cwd);
        break;
      case "error":
        window.webContents.send(`pty-error-${event.sessionId}`, event.message);
        break;
      // `paneFacts` is main's alone (ADR-184) — see `dispatchStreamEvent`.
    }
  } catch (err) {
    // Render frame disposed during window reload or close — safe to ignore
    if (!(err instanceof Error) || !err.message.includes("disposed")) {
      console.error("Error in stream event handler:", err);
    }
  }
}

export interface AgentStreamDeps {
  agentManager: Pick<AgentManager, "getAgentByPaneId" | "updateAgent">;
  agentStatus: Pick<AgentStatusDriver, "signal" | "forgetPane">;
  /** Broadcast an updated Agent (and refresh the dock badge). */
  broadcastAgent: (agent: AgentInfo) => void;
}

/**
 * The agent-domain side of a stream event, run ONCE per event in main — not
 * per window, as `handleStreamEvent` is (ADR-184):
 * - `paneFacts` → a Status signal for the pane, and the Agent's name from the
 *   terminal title (unless the user pinned one);
 * - `cwd` → the active Agent's cwd;
 * - `exit` → the pane's reconciler state is dropped.
 */
export function handleAgentStreamEvent(event: StreamEvent, deps: AgentStreamDeps): void {
  try {
    switch (event.type) {
      case "paneFacts": {
        deps.agentStatus.signal(event.sessionId, { type: "paneFacts", facts: event.facts });
        // Update the persisted Agent name from the terminal title — unless the
        // user pinned a name of their own, which the title sync must not
        // clobber.
        const cleaned = cleanAgentTitle(event.facts.title);
        if (cleaned) {
          const agent = deps.agentManager.getAgentByPaneId(event.sessionId);
          if (agent && !agent.namePinned && agent.name !== cleaned) {
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
 * (`handleAgentStreamEvent`), then the pane channels to every window. However
 * many windows are open, a signal reaches the Status reconciler once and its
 * effects are applied once (ADR-184). `paneFacts` never reaches a window.
 */
export function dispatchStreamEvent(
  event: StreamEvent,
  windows: readonly BrowserWindow[],
  agentDeps: AgentStreamDeps,
): void {
  handleAgentStreamEvent(event, agentDeps);
  if (event.type === "paneFacts") return;
  for (const win of windows) {
    // Check that the main frame is still available (avoids "Render frame was
    // disposed" errors during window reload/close).
    try {
      if (!win.webContents.mainFrame) continue;
    } catch {
      continue;
    }
    handleStreamEvent(event, win);
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
  const projectManager = new ProjectManager((hostId) => backendRegistry.get(hostId));
  for (const { hostId, spec } of projectManager.getHosts()) {
    backendRegistry.register(hostId, spec);
  }
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
  const themeManager = new ThemeManager();
  const portScanner = new PortScanner(backendRegistry);
  // Remote dev servers opened from Manor go through these (ADR-178 §5).
  const remoteForwards = new RemoteForwards(backendRegistry);
  // Which host each pane's workspace lives on, and the resolver that turns a
  // URL opened in that host's context into the one to load. Built here, once,
  // so `resolvePaneUrl` below is wired into `ControlDeps` before any IPC
  // module registers — no more racing a setter installed as a side effect of
  // `ports.register` (ADR-183).
  const paneHosts = new Map<string, string>();
  const remoteUrlResolver = new RemoteUrlResolver(portScanner, backendRegistry, remoteForwards);
  /**
   * The URL to actually load for a `navigate` in `paneId`'s webview
   * (`ControlDeps.resolvePaneUrl`): itself, or rewritten through the pane's
   * host's port forward for a remote workspace (ADR-178 §5). Gives up
   * (rejects) rather than wait forever on an absent host.
   */
  const resolvePaneUrl = async (paneId: string, url: string): Promise<string> => {
    const hostId = paneHosts.get(paneId);
    if (!hostId) return url;
    return remoteUrlResolver.resolve(url, hostId, NAVIGATE_HOST_WAIT_MS);
  };
  const branchWatcher = new BranchWatcher(backendRegistry);
  const diffWatcher = new DiffWatcher(backendRegistry);
  // `gh` runs here, where it is authenticated; a remote project's checkout
  // isn't, so it is told the repo from that checkout's origin instead.
  const githubManager = new GitHubManager(async (repoPath) => {
    if (projectManager.hostIdForPath(repoPath) === LOCAL_HOST_ID) return null;
    const origin = (await backend.git.exec(repoPath, ["remote", "get-url", "origin"])).trim();
    const repo = ghRepoFromRemoteUrl(origin);
    if (!repo) throw new Error(`Not a GitHub remote: ${origin}`);
    return repo;
  });
  const linearManager = new LinearManager();

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
      agentManager,
      backend,
      notificationStore,
      statsStore,
      preferencesManager,
      themeManager,
      portScanner,
      remoteControl,
      agentHookServer,
      agentStatus: agentStatusDriver,
      webviewServer,
      webviewPanes: webviewServer,
      resolvePaneUrl,
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

  // Ensure shell integration and agent hooks are set up — the same bootstrap
  // a remote daemon runs on its own host (ADR-160 ticket 10). A connector
  // that skips registration (e.g. a config it couldn't safely parse) is
  // reported here, not thrown — one agent's bad config must never abort
  // local startup.
  for (const warning of bootstrapHost().warnings) {
    console.warn(`[app-lifecycle] bootstrap: ${warning}`);
  }
  ensureManorCli();
  // The Home surface's harness runs in ~/.manor/home. Create it once here
  // instead of on every new session's launch command.
  fs.mkdirSync(homeWorkspaceDir(), { recursive: true });

  function broadcastAgent(agent: AgentInfo): void {
    sendAgentUpdate(mainWindow, agent, preferencesManager);
  }

  /** Send to every live renderer window whose main frame is still there. */
  function sendToRendererWindows(channel: string, ...args: unknown[]): void {
    for (const win of getRendererWindows()) {
      try {
        if (!win.webContents.mainFrame) continue;
        win.webContents.send(channel, ...args);
      } catch {
        // Render frame disposed during reload/close — safe to ignore.
      }
    }
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
      // One channel, every window, once per signal (ADR-184 §4).
      sendToRendererWindows("agent-status", update);
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

  // Set up stream event handler — broadcast events to every live renderer
  // window. A detached window hosting a terminal pane must receive its `pty:*`
  // stream events; windows that don't own the pane ignore them harmlessly.
  // Events arrive tagged with their host. The registry has already used the
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

  backendRegistry.onEvent((hostId: string, event: StreamEvent) => {
    // A remote pane whose session a daemon restart took is not closed like
    // one whose shell exited: the renderer recovers it when the host's
    // `hosts:reconnected` arrives (ADR-178 §6).
    if (isRemoteSessionLoss(hostId, event)) return;
    dispatchStreamEvent(event, getRendererWindows(), {
      agentManager,
      agentStatus: agentStatusDriver,
      broadcastAgent,
    });
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
    backendRegistry,
    getPaneHostId,
    layoutPersistence,
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
    agentHookServer,
    agentManager,
    agentStatus: agentStatusDriver,
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

  // Give control routes (ADR-171) the same manager bag IPC handlers have.
  webviewServer.setControlDeps({
    projectManager: ipcDeps.projectManager,
    githubManager: ipcDeps.githubManager,
    linearManager: ipcDeps.linearManager,
    layoutPersistence: ipcDeps.layoutPersistence,
    agentManager: ipcDeps.agentManager,
    backend: ipcDeps.backend,
    notificationStore: ipcDeps.notificationStore,
    statsStore: ipcDeps.statsStore,
    preferencesManager: ipcDeps.preferencesManager,
    themeManager: ipcDeps.themeManager,
    portScanner: ipcDeps.portScanner,
    remoteControl: ipcDeps.remoteControl,
    agentHookServer: ipcDeps.agentHookServer,
    agentStatus: agentStatusDriver,
    getRendererWindows: ipcDeps.getRendererWindows,
    // Pane inspection routes' access to WebviewServer's own pane registry
    // and console-log buffers (ADR-183) — always itself.
    webviewPanes: webviewServer,
    resolvePaneUrl,
  });
  // Remote hosts' `manor` CLIs reach the same routes, with the same deps,
  // behind the remote allowlist (ADR-189 §2). Set once those deps exist; a
  // request relayed before then is answered 503.
  backendRegistry.setControlRelaySink((hostId, req) =>
    handleRelayedControlRequest(webviewServer.getControlDeps(), hostId, req),
  );

  ptyIpc.register(ipcDeps);
  layoutIpc.register(ipcDeps);
  projectsIpc.register(ipcDeps);
  themeIpc.register(ipcDeps);
  portsIpc.register(ipcDeps);
  branchesDiffsIpc.register(ipcDeps);
  integrationsIpc.register(ipcDeps);
  webviewIpc.register(ipcDeps);
  agentsIpc.register(ipcDeps);
  notificationsIpc.register(ipcDeps);
  statsIpc.register(ipcDeps);
  miscIpc.register(ipcDeps);
  processesIpc.register(ipcDeps);
  windowIpc.register(ipcDeps);
  remoteControlIpc.register(ipcDeps);
  menuIpc.register(ipcDeps);
  hostsIpc.register(ipcDeps);

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
    initAutoUpdater(() => mainWindow);

    // Start agent hook server FIRST to get the port number.
    // The port must be in process.env BEFORE the daemon spawns,
    // because the daemon inherits env at spawn time and passes it
    // to PTY sessions (which need MANOR_HOOK_PORT for hook scripts).
    await agentHookServer.start();
    process.env.MANOR_HOOK_PORT = String(agentHookServer.hookPort);
    // Only remote-namespace panes set this; if Manor was launched from one,
    // local panes would otherwise send hooks to the remote daemon's listener.
    delete process.env.MANOR_HOOK_PORT_FILE;

    await webviewServer.start();
    await portlessManager.start();
    process.env.MANOR_WEBVIEW_PORT = String(webviewServer.serverPort);
    process.env.MANOR_PORTLESS_PORT = String(portlessManager.proxyPort);

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
    // Takes down the ssh children; remote sessions keep running on their hosts.
    void backendRegistry.disconnectAll();
    killAllActivePushes();
    statsStore.flushNow();
    projectManager.flushHostHookSeqs();
    worktreeWatcher.dispose();
    remoteWorktreePoller.dispose();
  });
}
