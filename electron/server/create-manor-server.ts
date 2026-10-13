/**
 * `createManorServer(platform)` (ADR-227 D1): the one composition of a Manor
 * server, shared by the desktop's `initApp()` (`../app-lifecycle.ts`) and the
 * host server's `createHostServer()` (`../host-server/server.ts`).
 *
 * It builds, in the order `initApp` always has:
 *
 *   daemon client, local backend, `BackendRegistry`
 *     ──▶ `ProjectManager`, `LayoutPersistence`, worktree watchers
 *     ──▶ `RoutedBackend`, the server's launches, `LayoutStore`
 *     ──▶ theme, ports, GitHub, Linear, the relay stores
 *     ──▶ preferences, agents, stats, notifications, `workspaceOps`
 *     ──▶ the agent pipeline, resyncs, `ChatMirror`, the stream fan-out
 *     ──▶ the caller's deps, then `BridgeServer` over the caller's table
 *
 * What differs between platforms comes in through `Platform`
 * (`./platform.ts`). What only one caller has — the desktop's windows,
 * menu, webview server and remote control; the host server's owner sync,
 * relay room and winsize hold — the caller adds in `opts.deps`, which is
 * handed every shared part and answers the deps object the bridge's table
 * runs over. So the bridge is built once its deps exist, never late.
 *
 * Starting and stopping are split where the two callers' orders differ:
 * `initSecrets()` and `start()` are called by each caller at its own point,
 * and `stop()` is the shared middle of a shutdown.
 *
 * Electron-free: the host server bundles it
 * (`../platform/__tests__/electron-free.test.ts`).
 */

import path from "node:path";
import { AgentActivityStore } from "../agent-activity-store";
import { AgentManager, agentHostId, type AgentInfo } from "../agent-persistence";
import {
  createAgentPipeline,
  resyncPaneFacts,
  serverAgentPipelineOptions,
  type AgentPipeline,
  type AgentStatusSink,
} from "../agent-status/pipeline";
import type { AgentStatusDriverDeps } from "../agent-status/driver";
import type { PaneContext } from "../agent-status/effects";
import { UnseenAgents } from "../agent-status/unseen-agents";
import { dispatchStreamEvent } from "../agent-stream-events";
import type { HookCursor } from "../backend/hook-feed";
import { createLocalBackend, type HostBackend } from "../backend/host-backend";
import {
  BackendRegistry,
  isRemoteSessionLoss,
  type HostStatus,
} from "../backend/registry";
import { RoutedBackend } from "../backend/routed-backend";
import { LOCAL_HOST_ID, type WorkspaceBackend } from "../backend/types";
import { createAgentService } from "../bridge/handlers/agents";
import { killAllActivePushes } from "../bridge/handlers/branches-diffs";
import { wireChatMirror } from "../bridge/handlers/chat";
import type { HandlerTable } from "../bridge/method";
import { BridgeServer, type BridgeServerDeps } from "../bridge/server";
import { ChatMirror, transcriptSources } from "../chat-mirror/mirror";
import { chatTaskKey } from "../chat-mirror/task-key";
import { LocalTranscriptSource } from "../chat-mirror/transcript-source";
import { GitHubManager, ghRepoFromRemoteUrl } from "../github";
import type { ServerDeps } from "../ipc/types";
import { KeybindingsManager } from "../keybindings";
import { LayoutStore } from "../layout/layout-store";
import { LinearManager } from "../linear";
import { NotificationStore } from "../notification-store";
import { ProjectManager } from "../persistence";
import { PortScanner } from "../ports";
import { PreferencesManager } from "../preferences";
import {
  RemoteWorktreePoller,
  WorktreeWatcher,
} from "../projects/worktree-watcher";
import { RemoteAuditLog } from "../remote-control/audit";
import { RemoteDeviceStore } from "../remote-control/devices";
import { PushManager, type VapidKeys } from "../remote-control/push";
import { RelayIdentityStore } from "../remote-control/relay/identity";
import { createBroadcastBus, type BroadcastBus } from "../renderer-broadcast";
import { StatsStore } from "../stats-store";
import { countBusyAgents } from "../stats-signals";
import { TerminalHostClient } from "../terminal-host/client";
import { LayoutPersistence } from "../terminal-host/layout-persistence";
import type { ConnectionListener } from "../terminal-host/reconnect-supervisor";
import type { StreamEvent } from "../terminal-host/types";
import { ThemeManager } from "../theme";
import { createWorkspaceOps } from "../workspace-ops";
import { pickPaneAgent } from "../../src/lib/pane-agent";
import { HeadlessNotifier } from "./headless-notifier";
import { layoutPaneContext } from "./pane-context";
import type { Platform } from "./platform";
import { createServerLaunches } from "./spawn-pane";

/**
 * How long the one-time layout.json key migration (ADR-191) waits for a
 * remote host to say where its worktrees live. It holds up the first
 * `layout.getAll()` after the upgrade, so it is kept short: a host that misses
 * it is still matched by its project root and remembered workspace paths.
 */
const LAYOUT_MIGRATION_HOST_WAIT_MS = 5_000;

/** The `ServerDeps` every server builds the same way; the caller adds the rest. */
export type SharedDeps = Pick<
  ServerDeps,
  | "backend"
  | "backendRegistry"
  | "getPaneHostId"
  | "layoutPersistence"
  | "layoutStore"
  | "projectManager"
  | "themeManager"
  | "portScanner"
  | "githubManager"
  | "linearManager"
  | "agentHookServer"
  | "agentManager"
  | "agentStatus"
  | "chatMirror"
  | "notificationStore"
  | "statsStore"
  | "workspaceOps"
  | "agentActivityStore"
  | "preferencesManager"
  | "keybindingsManager"
  | "paneContextMap"
  | "unseen"
  | "notifier"
  | "sessionOwners"
  | "hostStatus"
  | "playSound"
  | "appCommandResult"
>;

/** Every shared part: what `opts.deps` is handed and `ManorServer` exposes. */
export interface ManorCore {
  platform: Platform;
  /** The server's keyless pushes; its bridge listens on it. */
  bus: BroadcastBus;
  /** The server's own daemon. */
  client: TerminalHostClient;
  /** That daemon's backends, unrouted. */
  localBackend: WorkspaceBackend & HostBackend;
  shared: SharedDeps;
  agentPipeline: AgentPipeline;
  /** The relay stores, decrypted by `initSecrets()` or the caller's relay. */
  relayStores: {
    identity: RelayIdentityStore;
    devices: RemoteDeviceStore;
    push: PushManager;
  };
  /** Resync a host's panes after it (re)connects (`resyncPaneFacts`). */
  resyncHostPanes(hostId: string, sessionIds?: readonly string[]): Promise<void>;
}

export interface ManorServerOptions<D extends BridgeServerDeps> {
  /** The handler table the server's bridge dispatches on. */
  table: HandlerTable<D>;
  /** The deps that table runs over: the shared parts plus the caller's own. */
  deps: (core: ManorCore) => D;
  /**
   * A status transition worth telling someone about (a banner, a push);
   * a replay's are coalesced. Read once the pipeline has started.
   */
  onAgentStatus?: AgentStatusSink;
  /**
   * A pane's context when neither a renderer nor the server's own layout
   * knows it (`serverAgentPipelineOptions`).
   */
  derivePaneContext?: (paneId: string) => PaneContext | undefined;
  /** The daemon connection's own listener; the resync on reconnect is added. */
  daemonListener?: ConnectionListener;
  /** The relay stores' files and push's network, where they are not the defaults. */
  relayStores?: {
    identityFile?: string;
    devicesFile?: string;
    vapidFile?: string;
    pushSend?: ConstructorParameters<typeof PushManager>[3];
    pushGenerate?: () => VapidKeys | Promise<VapidKeys>;
  };
  /** Driver clocks and log, for tests. */
  clocks?: Pick<AgentStatusDriverDeps, "monoClock" | "wallClock" | "log">;
}

export interface ManorServer<D extends BridgeServerDeps> extends ManorCore {
  deps: D;
  bridge: BridgeServer<D>;
  /**
   * Decrypt the secrets the stores keep in memory: paired devices, relay
   * identity, push key and the Linear token. A store that cannot be read
   * stays unread (and its file untouched). Never rejects.
   */
  initSecrets(): Promise<void>;
  /** Relay hooks into the Status reconciler and start its tick. */
  start(): void;
  /**
   * The shared part of a shutdown: flush what is pending, let go of the
   * bridge, the chat mirror and every remote host. The caller stops its own
   * listeners before and flushes its own stores after.
   */
  stop(): void;
}

export function createManorServer<D extends BridgeServerDeps>(
  platform: Platform,
  opts: ManorServerOptions<D>,
): ManorServer<D> {
  const { dataDir, secretBox } = platform;
  const bus = platform.bus ?? createBroadcastBus();
  const notifyProjectsChanged = (): void => bus.publish("projects", "changed");

  // Managers
  // The local daemon is handshaken against the app's version. A stale daemon
  // it replaces reports the sessions it is about to kill through the
  // registry, like a remote host's (ADR-185 §A); only ever called from
  // `connect()`, long after `backendRegistry` exists.
  const client = new TerminalHostClient(platform.appVersion, platform.daemonTransport, (sessionIds) =>
    backendRegistry.reportDaemonReplacing(LOCAL_HOST_ID, sessionIds),
  );
  const localBackend = createLocalBackend(client);
  // Every host's backend, "local" always among them (ADR-160 §6). Remote
  // hosts come from projects.json below and connect lazily, off the launch
  // path; with none registered everything routes to the local backend.
  const { remoteHosts } = platform;
  const backendRegistry = new BackendRegistry({
    local: localBackend,
    remoteVersion: remoteHosts?.remoteVersion ?? platform.appVersion,
    // Where each remote host's hook journal was read up to (ADR-178 §2).
    // Only read once hosts are registered, after projectManager exists.
    ...(remoteHosts
      ? {
          hookSeqStore: {
            get: (hostId: string): HookCursor | null => projectManager.getHostHookCursor(hostId),
            set: (hostId: string, cursor: HookCursor): void =>
              projectManager.setHostHookCursor(hostId, cursor),
          },
        }
      : {}),
  });
  const layoutPersistence = new LayoutPersistence(platform.layoutFile);
  // Each project's git, shell and machine facts come from its host (ADR-183).
  // A remote project keeps its last workspace listing only while its host
  // is away (ADR-192 §5).
  const projectManager = new ProjectManager((hostId) => backendRegistry.get(hostId), dataDir, {
    isHostAway: (hostId) => backendRegistry.status(hostId) !== "connected",
    // Removing a worktree or a project tears its layout down first (ADR-182
    // D7), whichever caller — sidebar, quick merge, CLI or MCP — asked for it.
    // Read at call time: the store is built just below.
    layout: { remove: (key) => layoutStore.remove(key) },
    // Setup and clone progress go to the server's renderers.
    publish: bus.publishTo,
  });
  if (remoteHosts) {
    for (const { hostId, spec } of projectManager.getHosts()) {
      backendRegistry.register(hostId, spec);
    }
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
  // host is inferred from its path (ADR-183); the pollers are handed each
  // workspace's host instead.
  const backend = new RoutedBackend(
    backendRegistry,
    (p) => projectManager.hostIdForPath(p),
    (pid) => portScanner.hostsListeningOn(pid),
  );
  // Agent launches and setup scripts start here, not in a renderer (ADR-227
  // D5): the layout store hands every launched pane over as it joins a tree.
  // Spawning reads the caller's deps, built below, for the desktop's prewarm.
  const launches = createServerLaunches({
    spawnDeps: () => ({
      backend,
      backendRegistry,
      layoutStore,
      prewarmManager: (deps as Partial<Pick<ServerDeps, "prewarmManager">>).prewarmManager,
    }),
    projectManager,
    publishSetupProgress: (origin, event) =>
      bus.publishTo(origin, "projects", "worktreeProgress", event),
  });
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
    (payload) => bus.publish("layout", "changed", payload),
    backend,
    // Which renderer is the primary window, and the tab a detached window
    // holds (ADR-179 D4). A server with no windows has neither.
    platform.windows,
    // A pane's title, off the command channel (ADR-182 D1) — the same bus as
    // `layout.changed`, on its own event so a renderer's replica does not
    // have to replace itself for a title.
    (paneId, title) => bus.publish("layout", "paneTitle", { paneId, title }),
    // Every pane the store ends takes its agent with it (ADR-182 D7) — the
    // one abandonment for every close path, a removed workspace, and a
    // legacy Home entry dropped on load. Read at call time: the agent side
    // is built below.
    {
      abandonForPanes: (panes) => agentService.abandonForPanes(panes),
    },
    launches,
  );
  // Read the file once its workspace-key migration (above) has settled —
  // usually at once; `layout.getAll()` and every command wait for it, so a
  // renderer only ever sees host-qualified keys.
  void layoutStore.startLoad(layoutPersistence.whenReady());
  const themeManager = new ThemeManager();
  const portScanner = new PortScanner(backendRegistry);
  // `gh` runs here, where it is authenticated. On a server with remote hosts,
  // a remote project's checkout isn't, so it is told the repo from that
  // checkout's origin instead, read on the host the caller named (ADR-191).
  // A server with none runs `gh` in every checkout (ADR-225 D8).
  const githubManager = remoteHosts
    ? new GitHubManager(async (hostId, repoPath) => {
        const origin = (
          await backendRegistry.get(hostId).git.exec(repoPath, ["remote", "get-url", "origin"])
        ).trim();
        const repo = ghRepoFromRemoteUrl(origin);
        if (!repo) throw new Error(`Not a GitHub remote: ${origin}`);
        return repo;
      })
    : new GitHubManager();
  // The remote-control and relay modules take their platform from these ports
  // rather than importing Electron, so every server can build them (ADR-225 D6).
  const linearManager = new LinearManager(secretBox);
  // One identity store for Jev and the relay: each caches the decrypted keys,
  // so a second instance would go stale when the relay address is reset.
  const relayFiles = opts.relayStores ?? {};
  const relayIdentityStore = new RelayIdentityStore(secretBox, relayFiles.identityFile);
  const remoteDeviceStore = new RemoteDeviceStore(secretBox, relayFiles.devicesFile);
  const remotePush = new PushManager(
    remoteDeviceStore,
    secretBox,
    relayFiles.vapidFile,
    relayFiles.pushSend,
    relayFiles.pushGenerate,
  );

  // PreferencesManager must be constructed before AgentManager so we can pass
  // the user's configured retention into the prune step.
  const preferencesManager = new PreferencesManager(dataDir);
  // An agent saved before ADR-191 has no host: it takes its project's.
  const agentManager = new AgentManager(
    dataDir,
    preferencesManager.get("agentRetentionDays"),
    (projectId) => projectManager.getProjectHostId(projectId),
  );
  const keybindingsManager = new KeybindingsManager(dataDir);
  // ADR-162's durable notification log. Handed to the notifier so the
  // single recording site can reach it.
  const notificationStore = new NotificationStore(dataDir);
  // ADR-168's usage stats.
  const statsStore = new StatsStore(dataDir, {
    isEnabled: () => preferencesManager.get("statsEnabled"),
    onBadge: (badge) => {
      notificationStore.append({
        kind: "badge-unlocked",
        title: `Badge unlocked: ${badge.title}`,
        body: badge.description,
        target: { type: "stats", badgeId: badge.id },
      });
      notifier.sendNotificationsUpdate();
    },
  });
  // The server's unseen flags and the notifications built on them (ADR-227
  // D1): one of each per server, shared by the status pipeline, the handlers
  // and the broadcast.
  const unseen = new UnseenAgents();
  const notifierParts = {
    notificationStore,
    statsStore,
    unseen,
    preferencesManager,
    publish: bus.publish,
  };
  const notifier =
    platform.notifier?.(notifierParts) ?? new HeadlessNotifier(notifierParts);
  // ADR-203: one workspace lifecycle for both IPC and the control routes, so
  // stats, last-used host and the broadcast happen whichever transport asked.
  const workspaceOps = createWorkspaceOps({
    projectManager,
    statsStore,
    notifyProjectsChanged,
    runSetupScript: launches.runSetupScript,
  });
  // ADR-199's persistent Agent activity history, fed by `publishPaneStatus`.
  const agentActivityStore = new AgentActivityStore(dataDir);
  // A merged PR ships a workspace just as much as a quick merge does, and it
  // is the only shipping path the app never initiates itself — the PR poll is
  // where it surfaces. Counted once per PR, so a worktree kept around after
  // the merge does not keep counting (ADR-168 §2, amended 2026-09-10).
  githubManager.setPrMergedListener((prUrl) => {
    statsStore.recordOnce("prsMerged", prUrl);
  });

  const paneContextMap: ServerDeps["paneContextMap"] = new Map();

  // ── Agent status (ADR-184) ─────────────────────────────────────────────
  // The Status reconciler's driver: the one decider of every pane's Agent
  // status, and the only writer of Agents' lifecycle and last status. Built
  // before the handlers and routes that feed it user signals.

  /**
   * A pane's session owner: the host its terminal runs on (ADR-191 §5). On a
   * server with no remote hosts, every pane is local.
   */
  const getPaneHostId = remoteHosts
    ? (paneId: string) => backendRegistry.sessions.ownerOf(paneId)
    : (paneId: string) => backendRegistry.sessions.ownerOf(paneId) ?? LOCAL_HOST_ID;

  const broadcastAgent = (agent: AgentInfo): void => notifier.sendAgentUpdate(agent);

  // The agent pipeline (`agent-status/pipeline.ts`): local HTTP hooks and
  // remote hosts' journaled hooks take the same path (ADR-178 §2), and a
  // replay's notifications are coalesced to one banner per agent, not
  // hundreds.
  const agentPipeline = createAgentPipeline(serverAgentPipelineOptions({
    agentManager,
    paneContexts: paneContextMap,
    // Which project and workspace a pane is in, from this server's own layout
    // and projects (ADR-227 D5): a launched agent has no renderer to say.
    layoutPaneContext: (paneId) => layoutPaneContext(layoutStore, projectManager, paneId),
    derivePaneContext: opts.derivePaneContext,
    getPaneHostId,
    unseen,
    broadcastAgent,
    onStatus: (agent, prevStatus, newStatus) =>
      opts.onAgentStatus?.(agent, prevStatus, newStatus),
    // Each hook also pokes the pane's chat mirror, after the driver has
    // captured any new transcript path: the hooks are when a transcript
    // grows, and a remote one has no file watch (ADR-216 D3). Hooks reach
    // here only after `agentPipeline.start()`, once `chatMirror` exists.
    onHook: (event) => chatMirror.poke(event.paneId),
    publishPaneStatus: (update) => {
      // One event, every renderer — windows and browsers alike — once per
      // signal (ADR-184 §4, ADR-180 D5): `agents.onStatus`.
      bus.publish("agents", "status", update);
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
    ...(opts.clocks ? { clocks: opts.clocks } : {}),
  }));
  const agentStatusDriver = agentPipeline.driver;
  backendRegistry.setHookSink(agentPipeline.hookSink);

  // The agents side of a pane leaving a tree (ADR-182 D7): the store calls it
  // for every pane it ends, and the abandonment is a `user` signal to the
  // Status reconciler like any other close (ADR-184).
  const agentService = createAgentService({
    agentManager,
    statsStore,
    notifier,
    agentStatus: agentStatusDriver,
  });

  /** Resync a host's panes after it (re)connects (`resyncPaneFacts`). */
  async function resyncHostPanes(hostId: string, sessionIds?: readonly string[]): Promise<void> {
    try {
      await resyncPaneFacts(backendRegistry.get(hostId).pty, agentStatusDriver, sessionIds);
    } catch (err) {
      console.debug(`[agent-status] resync of ${hostId} failed:`, err);
    }
  }

  // A daemon about to be replaced (local or remote) kills every pty on it.
  // Those Agents did not finish: their SessionEnd must not complete them, so
  // the renderer's cold restore resumes them (ADR-185 §A). Subscribed before
  // any `connect()` (the event fires inside it); a SessionEnd the hook server
  // hears before `agentPipeline.start()` is queued and replayed after,
  // still inside the window.
  backendRegistry.onDaemonReplacing((_hostId, sessionIds) => {
    agentStatusDriver.expectPaneLoss(sessionIds);
  });

  // The local daemon's reconnects (its client's supervisor)...
  const { daemonListener } = opts;
  client.setConnectionListener({
    ...daemonListener,
    onReconnected: (info) => {
      daemonListener?.onReconnected?.(info);
      void resyncHostPanes(LOCAL_HOST_ID, info.sessionIds);
    },
  });
  // ...and remote hosts' (their `hostReconnected` carries the survivors).
  backendRegistry.onHostEvent((hostId, event) => {
    if (event.type === "hostReconnected") void resyncHostPanes(hostId, event.sessionIds);
  });

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
          void resyncHostPanes(host.hostId);
        }
      }
    }
  });

  // ADR-215: each pane's Claude transcript, for the phone's chat view. It
  // publishes through the bridge, which is built below; nothing is published
  // before somebody subscribes, and nobody can before the bridge exists.
  // A remote agent's transcript is read through its host's shell exec
  // (ADR-216 D2), which fails fast while the host is not connected.
  const sourceFor = transcriptSources(new LocalTranscriptSource(), (hostId) => {
    if (!backendRegistry.has(hostId)) return null;
    const { shell } = backendRegistry.get(hostId);
    return {
      file: async (cmd, args, execOpts) => ({
        stdout: await shell.exec(cmd, args, execOpts),
        stderr: "",
      }),
    };
  });
  const chatMirror = new ChatMirror({
    agentForPane: (paneId) => {
      const agent = pickPaneAgent(agentManager.getAllAgents(), paneId);
      if (!agent) return null;
      return {
        hostId: agentHostId(agent, getPaneHostId),
        agentKind: agent.agentKind,
        transcriptPath: agent.transcriptPath,
      };
    },
    sourceFor,
    write: (paneId, data) => backend.pty.write(paneId, data),
    publish: (paneId, entry) => bridge.publish("chat", "entry", [paneId, entry], paneId),
    // ADR-224 D3: keyed by pane and task, so only that task's subscribers hear it.
    publishTask: (paneId, taskId, entry) =>
      bridge.publish(
        "chat",
        "taskEntry",
        [paneId, taskId, entry],
        chatTaskKey(paneId, taskId),
      ),
  });

  // Every session's output, in one place. Events arrive tagged with their
  // host. The registry has already used the tag to record which host owns
  // the session (so pane calls route back to it) and dropped any event for a
  // session another host owns; the pane channels themselves stay keyed by
  // pane id, which is unique across hosts.
  backendRegistry.onEvent((hostId: string, event: StreamEvent) => {
    // A remote pane whose session a daemon restart took is not closed like
    // one whose shell exited: the renderer recovers it when the host's
    // `hosts:reconnected` arrives (ADR-178 §6).
    if (isRemoteSessionLoss(hostId, event)) return;
    // `paneSessions` is server-derived (ADR-179 D3): cwd and title reach the
    // layout file from the stream, not from a renderer reporting what it saw.
    layoutStore.onPtyEvent(event);
    // A pane's shell is gone: its transcript watcher goes with it (ADR-215),
    // and a setup script's tab closes (ADR-227 D5).
    if (event.type === "exit") {
      chatMirror.closePane(event.sessionId);
      launches.onExit(event.sessionId);
    }
    // Every host's stream events arrive here and only here, so this is where
    // the bridge is fed (ADR-180 D5) — the only consumer that forwards, to a
    // renderer window and a paired device alike.
    dispatchStreamEvent(
      event,
      { agentManager, agentStatus: agentStatusDriver, broadcastAgent },
      (e) => bridge.handleStreamEvent(e),
    );
  });

  const core: ManorCore = {
    platform,
    bus,
    client,
    localBackend,
    shared: {
      backend,
      backendRegistry,
      getPaneHostId,
      layoutPersistence,
      layoutStore,
      projectManager,
      themeManager,
      portScanner,
      githubManager,
      linearManager,
      agentHookServer: agentPipeline.ingestion,
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
      unseen,
      notifier,
      sessionOwners: backendRegistry.sessions,
      hostStatus: (hostId) => backendRegistry.status(hostId),
      // The sinks the shared handlers reach the platform through (ADR-227 D1).
      playSound: platform.playSound,
      appCommandResult: platform.appCommandResult,
    },
    agentPipeline,
    relayStores: {
      identity: relayIdentityStore,
      devices: remoteDeviceStore,
      push: remotePush,
    },
    resyncHostPanes,
  };

  // The caller's deps: the shared parts plus its own (ADR-182 D8).
  const deps = opts.deps(core);

  // The bridge (ADR-178 D8, ADR-180 D1): one table of what this server can
  // do, built once its deps exist. Every transport attaches to it.
  const bridge = new BridgeServer(deps, {
    table: opts.table,
    events: bus.subscribe,
    audit: new RemoteAuditLog(path.join(dataDir, "remote-audit.jsonl")),
  });
  const unwireChat = wireChatMirror({ chatMirror }, bridge, bus.subscribe);

  return {
    ...core,
    deps,
    bridge,

    async initSecrets() {
      // The secret box is async; the stores' APIs are not.
      const initSecret = (label: string, init: Promise<void>) =>
        init.catch((err: unknown) => {
          console.error(`[remote-control] could not read ${label}:`, err);
        });
      await Promise.all([
        initSecret("paired devices", remoteDeviceStore.init()),
        initSecret("relay identity", relayIdentityStore.init()),
        initSecret("push key", remotePush.init()),
        linearManager.init(),
      ]);
    },

    start() {
      // Update the dock badge whenever preferences change (e.g. the user
      // toggles dockBadgeEnabled).
      preferencesManager.onChange(() => {
        notifier.updateDockBadge();
      });
      // Every hook — local HTTP and remote hook-feed replay alike, through
      // `ingestHookPayload` — is a Status signal for the reconciler (ADR-184);
      // the daemon's AgentDetector no longer hears about hooks. Hooks heard
      // before this were queued and are replayed now. One tick, on the old
      // sweep cadence, carries every time-based rule.
      agentPipeline.start();
    },

    stop() {
      agentPipeline.ingestion.stop();
      // The layout debounce is 300ms; a stop inside that window must not be
      // the one that loses the user's arrangement.
      layoutStore.flush();
      // The caller has closed its transports by now; disposing the surface
      // releases the broadcast and attachment sinks so nothing publishes into
      // a connection set that is gone.
      unwireChat();
      bridge.dispose();
      chatMirror.dispose();
      // Takes down the ssh children; remote sessions keep running on their hosts.
      void backendRegistry.disconnectAll();
      killAllActivePushes();
      statsStore.flushNow();
      agentActivityStore.flush();
      agentActivityStore.dispose();
      projectManager.flushHostHookSeqs();
      worktreeWatcher.dispose();
      remoteWorktreePoller.dispose();
    },
  };
}
