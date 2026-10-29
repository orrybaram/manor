/**
 * `createManorServer(platform)`: the one composition of a Manor
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
 * On a platform with remote hosts (the desktop) it also builds `HostRouting`:
 * each adopted host's state comes from that host's server —
 * merged into the reads, routed to by the bridge, a remote pane's terminal
 * included — and `HostAdoption` hands a host's records to it.
 *
 * What differs between platforms comes in through `Platform`
 * (`./platform.ts`). What only one caller has — the desktop's windows,
 * menu, webview server and remote control; the host server's ownership state,
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
import { UnseenAgents } from "../agent-status/unseen-agents";
import { dispatchStreamEvent } from "../agent-stream-events";
import { createLocalBackend, type HostBackend } from "../backend/host-backend";
import {
  BackendRegistry,
  isRemoteSessionLoss,
  type HostStatus,
} from "../backend/registry";
import { RoutedBackend } from "../backend/routed-backend";
import { LOCAL_HOST_ID, type WorkspaceBackend } from "../backend/types";
import { HostAdoption } from "../backend/host-adoption";
import { createAgentService } from "../bridge/handlers/agents";
import { killAllActivePushes } from "../bridge/handlers/branches-diffs";
import { wireChatMirror } from "../bridge/handlers/chat";
import type { HandlerTable } from "../bridge/method";
import { BridgeServer, type BridgeServerDeps } from "../bridge/server";
import { ChatMirror } from "../chat-mirror/mirror";
import { chatTaskKey } from "../chat-mirror/task-key";
import { LocalTranscriptSource } from "../chat-mirror/transcript-source";
import { GitHubManager } from "../github";
import type { ServerDeps, SharedDeps } from "../ipc/types";
import { KeybindingsManager } from "../keybindings";
import { LayoutStore } from "../layout/layout-store";
import { LinearManager } from "../linear";
import { NotificationStore } from "../notification-store";
import { ProjectManager } from "../persistence";
import { PortScanner } from "../ports";
import { BranchWatcher } from "../branch-watcher";
import { DiffWatcher } from "../diff-watcher";
import { OpenFileWatcher } from "../open-file-watcher";
import { AgentFileAuthors } from "../agent-file-authors";
import { PreferencesManager } from "../preferences";
import { WorktreeWatcher } from "../projects/worktree-watcher";
import { RemoteAuditLog } from "../remote-control/audit";
import { RemoteDeviceStore } from "../remote-control/devices";
import { PushManager, type VapidKeys } from "../remote-control/push";
import { RelayIdentityStore } from "../remote-control/relay/identity";
import { createBroadcastBus, type BroadcastBus } from "../renderer-broadcast";
import { StatsStore } from "../stats-store";
import { countBusyAcross } from "../stats-signals";
import { TerminalHostClient } from "../terminal-host/client";
import { LayoutPersistence } from "../terminal-host/layout-persistence";
import type { ConnectionListener } from "../terminal-host/reconnect-supervisor";
import type { StreamEvent } from "../terminal-host/types";
import { ThemeManager } from "../theme";
import { createWorkspaceOps } from "../workspace-ops";
import { pickPaneAgent } from "../../src/lib/pane-agent";
import { parseWorkspaceKey, type WorkspaceKey } from "../../src/lib/workspace-key";
import type { LayoutClaim } from "../../src/lib/layout/visible-tabs";
import { HeadlessNotifier } from "./headless-notifier";
import { layoutPaneContext } from "./pane-context";
import type { Platform } from "./platform";
import { createServerLaunches } from "./spawn-pane";
import { HostRouting } from "./host-routing";
import { readRecipe } from "../backend/providers/recipes";
import type { HostProxy, HostPtyEvent } from "../backend/host-proxy";
import type { PendingCommand } from "../layout/pending-commands";

/**
 * How long the one-time layout.json key migration waits for a
 * remote host to say where its worktrees live. It holds up the first
 * `layout.getAll()` after the upgrade, so it is kept short: a host that misses
 * it is still matched by its project root and remembered workspace paths.
 */
const LAYOUT_MIGRATION_HOST_WAIT_MS = 5_000;

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
  /**
   * Hands each remote host's records to its server; the
   * caller runs it on every owner connect (`HostServerSync`). Absent on a
   * server with no remote hosts.
   */
  hostAdoption?: HostAdoption;
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
  /** The daemon connection's own listener; the resync on reconnect is added. */
  daemonListener?: ConnectionListener;
  /** The relay stores' files and push's network, where they are not the defaults. */
  relayStores?: {
    identityFile?: string;
    devicesFile?: string;
    vapidFile?: string;
    /** Where the Linear key is sealed; the desktop's own file by default. */
    linearTokenFile?: string;
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
  // registry, like a remote host's; only ever called from
  // `connect()`, long after `backendRegistry` exists.
  const client = new TerminalHostClient(platform.appVersion, platform.daemonTransport, (sessionIds) =>
    backendRegistry.reportDaemonReplacing(LOCAL_HOST_ID, sessionIds),
  );
  const localBackend = createLocalBackend(client);
  // Every host's backend, "local" always among them. Remote
  // hosts come from projects.json below and connect lazily, off the launch
  // path; with none registered everything routes to the local backend.
  const { remoteHosts } = platform;
  // The desktop as a client of each adopted host's server.
  // Everything it reads is built below and read only at call time.
  const routing: HostRouting | null = remoteHosts
    ? new HostRouting({
        registry: {
          hostProxy: (hostId: string): HostProxy | undefined => backendRegistry.hostProxy(hostId),
          remoteHostIds: (): string[] => backendRegistry.remoteHostIds(),
          sessions: {
            ownerOf: (sessionId: string): string | undefined =>
              backendRegistry.sessions.ownerOf(sessionId),
          },
          status: (hostId: string): HostStatus | undefined => backendRegistry.status(hostId),
          wake: (hostId: string): Promise<void> => backendRegistry.wake(hostId),
        },
        isAdopted: (hostId: string): boolean => projectManager.isHostAdopted(hostId),
        hasLocalProject: (projectId: string): boolean => !projectManager.isRemoteProject(projectId),
        pendingCommands: {
          peek: (paneId: string): PendingCommand | null => layoutStore.pendingCommands.peek(paneId),
          take: (paneId: string): PendingCommand | null => layoutStore.pendingCommands.take(paneId),
        },
        decorateProject: (result: unknown): unknown => projectManager.decorateRemoteResult(result),
        bus,
        handOver: async (hostId: string, projectIds: readonly string[]): Promise<void> => {
          const client = backendRegistry.hostServer(hostId);
          if (!client || !hostAdoption) throw new Error(`${hostId} has no host server`);
          await hostAdoption.handOver(hostId, client, projectIds);
        },
      })
    : null;
  /** Each recipe's bundled template, by recipe id, for `hostMarks`. */
  const recipeTemplates = new Map<string, string | undefined>();
  const backendRegistry = new BackendRegistry({
    local: localBackend,
    remoteVersion: remoteHosts?.remoteVersion ?? platform.appVersion,
    // `hosts.list` says which hosts a window may stream to.
    ...(remoteHosts ? { isAdopted: (hostId: string): boolean => projectManager.isHostAdopted(hostId) } : {}),
    // A host's profile and the project it was made for.
    ...(remoteHosts
      ? {
          hostMarks: (hostId: string): { profileId?: string; forProject?: string; template?: string } => {
            const profileId: string | undefined = projectManager.hostProfileId(hostId);
            const forProject: string | undefined = projectManager.hostForProject(hostId);
            // The recipe's template tells a pod from a container.
            const spec = projectManager.getHosts().find((h) => h.hostId === hostId)?.spec;
            let template: string | undefined;
            if (spec?.kind === "recipe") {
              // Read once per recipe: this runs for every host on every
              // status change, progress lines included. A recipe's template
              // is fixed when the recipe is written.
              if (!recipeTemplates.has(spec.recipeId)) {
                try {
                  recipeTemplates.set(spec.recipeId, readRecipe(spec.recipeId).template);
                } catch {
                  // A recipe gone or unreadable has no template to name; asked again next time.
                }
              }
              template = recipeTemplates.get(spec.recipeId);
            }
            return {
              ...(template !== undefined ? { template } : {}),
              ...(profileId !== undefined ? { profileId } : {}),
              ...(forProject !== undefined ? { forProject } : {}),
            };
          },
        }
      : {}),
    // Each remote host's state, from its own server, heard by
    // this server's renderers under the desktop's keys and the user's name
    // for the host. The host's server reads its own hook journal, so its
    // agents are republished whole and drive this desktop's notifications and
    // dock badge (`onAgentUpdate`). Labels, chat and progress are read at call
    // time, once their owners exist.
    ...(remoteHosts && routing
      ? {
          hostProxy: {
            bus,
            republishAgents: true,
            onAgentUpdate: (agent: AgentInfo, flags: { responded: boolean; requires_input: boolean }, previous: AgentInfo | undefined): void =>
              onRemoteAgentUpdate(agent, flags, previous),
            onUnseenRead: (ids: readonly string[], flags: { responded: string[]; requires_input: string[] }): void =>
              onRemoteUnseenRead(ids, flags),
            onProgress: (...args: Parameters<HostRouting["onProgress"]>): void =>
              routing.onProgress(...args),
            label: (hostId: string): string => projectManager.hostLabel(hostId),
            ...(remoteHosts.hostCacheDir ? { cacheDir: remoteHosts.hostCacheDir } : {}),
            // A remote pane's chat and terminal, to whoever here subscribed
            // to it. Its `winsizeOwner` is told each caller
            // here on its own.
            publishKeyed: (ns: "chat" | "pty", event: string, args: unknown[], key: string): void => {
              if (ns === "pty" && routing.onHostPtyEvent(event as HostPtyEvent, args, key)) return;
              bridge.publish(ns, event as never, args as never, key);
            },
            // A detached window's claim on a remote tab is the desktop's.
            claimsFor: (key: WorkspaceKey): LayoutClaim[] => layoutStore.claimsFor(key),
            // And it lets go of them when the tab leaves.
            onLayoutMoved: (key, before, after): void => {
              layoutStore.dropForeignClaims(key, before, after);
            },
          },
        }
      : {}),
  });
  const layoutPersistence = new LayoutPersistence(platform.layoutFile);
  // Each project's git, shell and machine facts come from its host.
  const projectManager = new ProjectManager((hostId) => backendRegistry.get(hostId), dataDir, {
    // Removing a worktree or a project tears its layout down first, whichever caller — sidebar, quick merge, CLI or MCP — asked for it.
    // Read at call time: the store is built just below.
    layout: {
      remove: (key) => layoutStore.remove(key),
      take: async (entries): Promise<void> => {
        await layoutStore.adopt(entries, null);
      },
      release: (keys): Promise<void> => layoutStore.release(keys),
    },
    // Setup and clone progress go to the server's renderers.
    publish: bus.publishTo,
    // Adopted hosts' projects, from their servers.
    ...(routing ? { remote: routing.remoteProjects() } : {}),
  });
  if (remoteHosts) {
    for (const { hostId, spec } of projectManager.getHosts()) {
      backendRegistry.register(hostId, spec);
    }
  }
  // layout.json used to key its workspaces by bare path. Rekey it
  // once by host plus path, off the launch path; the layout store waits for it.
  void layoutPersistence.startWorkspaceKeyMigration(() =>
    projectManager.workspaceKeyOwners(LAYOUT_MIGRATION_HOST_WAIT_MS),
  );
  // Worktrees made or removed outside Manor (an agent's `git worktree add`)
  // never pass through a route that notifies the renderer; watch for them.
  const worktreeWatcher = new WorktreeWatcher(notifyProjectsChanged);
  const syncWorktreeWatchers = () => {
    worktreeWatcher.sync(projectManager.localProjectPaths());
  };
  syncWorktreeWatchers();
  projectManager.onStateSaved(syncWorktreeWatchers);
  // The one backend IPC handlers and control routes see: routes each pane,
  // cwd and pid to the host that owns it. A bare cwd is the only thing whose
  // host is inferred from its path; the pollers are handed each
  // workspace's host instead.
  const backend = new RoutedBackend(
    backendRegistry,
    (p) => projectManager.hostIdForPath(p),
    (pid) => portScanner.hostsListeningOn(pid),
    // An adopted host's sessions are its server's to create and attach:
    // `pty.*` for one is forwarded there.
    routing ? (hostId) => routing.proxy(hostId) !== null : undefined,
    // A remote pane a desktop window started on its host's server itself
    // is that host's, by the host's own layout.
    routing
      ? (paneId) => {
          const key = routing.workspaceOfPane(paneId);
          return key === null ? null : parseWorkspaceKey(key).hostId;
        }
      : undefined,
  );
  // Agent launches and setup scripts start here, not in a renderer: the layout store hands every launched pane over as it joins a tree.
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
   * Layout is the Manor server's, not a renderer's. One broadcaster
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
    // holds. A server with no windows has neither.
    platform.windows,
    // A pane's title, off the command channel — the same bus as
    // `layout.changed`, on its own event so a renderer's replica does not
    // have to replace itself for a title.
    (paneId, title) => bus.publish("layout", "paneTitle", { paneId, title }),
    // Every pane the store ends takes its agent with it — the
    // one abandonment for every close path, a removed workspace, and a
    // legacy Home entry dropped on load. Read at call time: the agent side
    // is built below.
    {
      abandonForPanes: (panes) => agentService.abandonForPanes(panes),
      moveToWorkspace: (paneIds, workspacePath) =>
        agentService.moveToWorkspace(paneIds, workspacePath),
    },
    launches,
    // Above any version a client kept from this server's last run.
    Date.now(),
  );
  // Read the file once its workspace-key migration (above) has settled —
  // usually at once; `layout.getAll()` and every command wait for it, so a
  // renderer only ever sees host-qualified keys.
  void layoutStore.startLoad(layoutPersistence.whenReady());
  // A detached window's claim on a remote tab: the host's layout
  // goes out again, with it.
  if (routing) {
    layoutStore.onForeignClaims((key, origin) => routing.republishClaims(key, origin));
  }
  const themeManager = new ThemeManager();
  const portScanner = new PortScanner(backendRegistry);
  // Each workspace's branch and diff, watched on the server that owns it
  // for every connection that asks, and published on this
  // server's bus. A desktop polls its remote hosts through their backends.
  const branchWatcher = new BranchWatcher(backendRegistry, bus.publish);
  const diffWatcher = new DiffWatcher(backendRegistry, {
    // Paused while the desktop window is hidden, unless a paired browser is
    // subscribed to the diff events (read at scan time, once the bridge
    // exists). A host server has no window: nothing pauses it.
    ...(platform.diffWindow ? { window: platform.diffWindow } : {}),
    deviceWatching: () =>
      bridge.hasDeviceSubscriber("diffs", "changed") ||
      bridge.hasDeviceSubscriber("diffs", "fingerprintsChange"),
    publish: bus.publish,
  });
  // The files open in file panes, on whichever host they live, for each
  // connection that has them open: `files.changed` goes to that connection.
  const openFileWatcher = new OpenFileWatcher(backendRegistry, { publishTo: bus.publishTo });
  // Which agent last wrote each file, as its PostToolUse hooks say: a file
  // pane names it beside a changed file.
  const agentFileAuthors = new AgentFileAuthors();
  // `gh` runs here, in the checkout, with this machine's own sign-in. A
  // remote project's calls are routed to its host's server (`byGhRepo`),
  // which composes the same manager.
  const githubManager = new GitHubManager();
  // The remote-control and relay modules take their platform from these ports
  // rather than importing Electron, so every server can build them.
  const linearManager = new LinearManager(
    secretBox,
    opts.relayStores?.linearTokenFile,
    (connected) => bus.publish("linear", "connectionChanged", connected),
  );
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
  // An older saved agent has no host: it takes its project's.
  const agentManager = new AgentManager(
    dataDir,
    preferencesManager.get("agentRetentionDays"),
    (projectId) => projectManager.getProjectHostId(projectId),
  );
  // A host that has adopted its records owns its agents. The
  // desktop's own hook feed wrote more for it after the hand-over, which
  // were never handed over and now only repeat the host's.
  const adoptedHostIds = new Set(
    projectManager.getHosts().flatMap(({ hostId }) => (projectManager.isHostAdopted(hostId) ? [hostId] : [])),
  );
  if (adoptedHostIds.size > 0) {
    agentManager.removeAgents(
      agentManager
        .getAllAgents()
        .filter((agent) => adoptedHostIds.has(agent.hostId))
        .map((agent) => agent.id),
    );
  }
  const keybindingsManager = new KeybindingsManager(dataDir);
  // The durable notification log. Handed to the notifier so the
  // single recording site can reach it.
  const notificationStore = new NotificationStore(dataDir);
  // Usage stats.
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
  // The server's unseen flags and the notifications built on them: one of each per server, shared by the status pipeline, the handlers
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
  // One workspace lifecycle for both IPC and the control routes, so
  // stats, last-used host and the broadcast happen whichever transport asked.
  const workspaceOps = createWorkspaceOps({
    projectManager,
    statsStore,
    notifyProjectsChanged,
    runSetupScript: launches.runSetupScript,
    publishRemoveProgress: (origin, step) =>
      bus.publishTo(origin, "projects", "removeWorktreeProgress", step),
  });
  // The persistent Agent activity history, fed by `publishPaneStatus`.
  const agentActivityStore = new AgentActivityStore(dataDir);
  // A merged PR ships a workspace just as much as a quick merge does, and it
  // is the only shipping path the app never initiates itself — the PR poll is
  // where it surfaces. Counted once per PR, so a worktree kept around after
  // the merge does not keep counting (amended 2026-09-10).
  githubManager.setPrMergedListener((prUrl) => {
    statsStore.recordOnce("prsMerged", prUrl);
  });

  const paneContextMap: ServerDeps["paneContextMap"] = new Map();

  // ── Agent status ─────────────────────────────────────────────
  // The Status reconciler's driver: the one decider of every pane's Agent
  // status, and the only writer of Agents' lifecycle and last status. Built
  // before the handlers and routes that feed it user signals.

  /**
   * A pane's session owner: the host its terminal runs on. On a
   * server with no remote hosts, every pane is local.
   */
  const getPaneHostId = remoteHosts
    ? (paneId: string) => backendRegistry.sessions.ownerOf(paneId)
    : (paneId: string) => backendRegistry.sessions.ownerOf(paneId) ?? LOCAL_HOST_ID;

  const broadcastAgent = (agent: AgentInfo): void => notifier.sendAgentUpdate(agent);

  /**
   * A remote agent moved on its host's server: the dock badge
   * follows the host's unseen flags, and a transition into `responded` or
   * `requires_input` takes the same path a local one does — a banner, and a
   * push unless the host's own server sent it (`onAgentStatus`).
   */
  function onRemoteUnseenRead(
    agentIds: readonly string[],
    flags: { responded: string[]; requires_input: string[] },
  ): void {
    const responded = new Set(flags.responded);
    const input = new Set(flags.requires_input);
    for (const id of agentIds) {
      if (responded.has(id)) unseen.responded.add(id);
      else unseen.responded.delete(id);
      if (input.has(id)) unseen.requiresInput.add(id);
      else unseen.requiresInput.delete(id);
    }
    notifier.updateDockBadge();
  }

  function onRemoteAgentUpdate(
    agent: AgentInfo,
    flags: { responded: boolean; requires_input: boolean },
    previous: AgentInfo | undefined,
  ): void {
    for (const [set, on] of [
      [unseen.responded, flags?.responded],
      [unseen.requiresInput, flags?.requires_input],
    ] as const) {
      if (on) set.add(agent.id);
      else set.delete(agent.id);
    }
    notifier.updateDockBadge();
    // Remote hook events no longer reach `observeHookEvent`, so the busy
    // gauge is sampled here, once the proxy holds the update.
    statsStore.recordMax("maxConcurrentAgents", countBusyAcross(agentManager, routing));
    const status = agent.lastAgentStatus;
    const was = previous?.lastAgentStatus ?? null;
    if (status && status !== was) {
      opts.onAgentStatus?.(agent, was, status as Parameters<AgentStatusSink>[2]);
    }
  }

  // The agent pipeline (`agent-status/pipeline.ts`): local HTTP hooks and
  // remote hosts' journaled hooks take the same path, and a
  // replay's notifications are coalesced to one banner per agent, not
  // hundreds.
  const agentPipeline = createAgentPipeline(serverAgentPipelineOptions({
    agentManager,
    paneContexts: paneContextMap,
    // Which project and workspace a pane is in, from this server's own layout
    // and projects: a launched agent has no renderer to say.
    // A remote host's layout is its server's: a pane in it is
    // found there.
    layoutPaneContext: (paneId) =>
      layoutPaneContext(
        {
          workspaceOf: (id) => layoutStore.workspaceOf(id) ?? routing?.workspaceOfPane(id) ?? null,
        },
        projectManager,
        paneId,
      ),
    getPaneHostId,
    unseen,
    broadcastAgent,
    onStatus: (agent, prevStatus, newStatus) =>
      opts.onAgentStatus?.(agent, prevStatus, newStatus),
    // Each hook also pokes the pane's chat mirror, after the driver has
    // captured any new transcript path: the hooks are when a transcript
    // grows, and a remote one has no file watch. Hooks reach
    // here only after `agentPipeline.start()`, once `chatMirror` exists.
    onHook: (event) => {
      chatMirror.poke(event.paneId);
      if (event.type === "PostToolUse" && event.filePath) {
        agentFileAuthors.record(event.filePath, {
          paneId: event.paneId,
          agentKind: event.agentKind,
          at: Date.now(),
        });
      }
    },
    publishPaneStatus: (update) => {
      // One event, every renderer — windows and browsers alike — once per
      // signal: `agents.onStatus`.
      bus.publish("agents", "status", update);
      // Server-derived `paneSessions`: the last status reaches
      // the layout file for a cold restore to show.
      layoutStore.onPaneStatus(update);
      // Recorded per Agent, not per pane: panes are ephemeral.
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
        countBusyAcross(agentManager, routing),
        isRootSession,
        replacedRootSessionId,
      );
    },
    ...(opts.clocks ? { clocks: opts.clocks } : {}),
  }));
  const agentStatusDriver = agentPipeline.driver;

  // The desktop's half of adoption: what it holds for a host,
  // handed to that host's server, and moved projects after it.
  const hostAdoption = remoteHosts
    ? new HostAdoption({
        projectManager,
        agentManager,
        layoutStore,
        getPaneHostId,
        onProjectsRemoved: () => notifyProjectsChanged(),
        // A window may now open its own stream to the host.
        onAdopted: (hostId) => backendRegistry.adoptionChanged(hostId),
        // The renderer keeps the agents the desktop held until it hears.
        onAgentsRemoved: (ids) => bus.publish("agents", "removed", [...ids]),
      })
    : undefined;

  // The agents side of a pane leaving a tree: the store calls it
  // for every pane it ends, and the abandonment is a `user` signal to the
  // Status reconciler like any other close.
  const agentService = createAgentService({
    agentManager,
    statsStore,
    notifier,
    agentStatus: agentStatusDriver,
    paneContextMap,
  });

  /** Resync a host's panes after it (re)connects (`resyncPaneFacts`). */
  async function resyncHostPanes(hostId: string, sessionIds?: readonly string[]): Promise<void> {
    // An adopted host's server does its own.
    if (routing?.proxy(hostId)) return;
    try {
      await resyncPaneFacts(backendRegistry.get(hostId).pty, agentStatusDriver, sessionIds);
    } catch (err) {
      console.debug(`[agent-status] resync of ${hostId} failed:`, err);
    }
  }

  // A daemon about to be replaced (local or remote) kills every pty on it.
  // Those Agents did not finish: their SessionEnd must not complete them, so
  // the renderer's cold restore resumes them. Subscribed before
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
  // waiting on some unrelated mutation to trigger it.
  const lastHostStatus = new Map<string, HostStatus>();
  backendRegistry.onStatusChange((hosts) => {
    for (const host of hosts) {
      const prev = lastHostStatus.get(host.hostId);
      lastHostStatus.set(host.hostId, host.status);
      if (host.status === "connected" && prev !== "connected") {
        notifyProjectsChanged();
        // A remote host's first connect (a reconnect is `hostReconnected`'s):
        // its panes' facts may already say something.
        if (host.hostId !== LOCAL_HOST_ID && prev !== "reconnecting") {
          void resyncHostPanes(host.hostId);
        }
      }
    }
  });

  // Each pane's Claude transcript, for the phone's chat view. It
  // publishes through the bridge, which is built below; nothing is published
  // before somebody subscribes, and nobody can before the bridge exists.
  // A remote agent's transcript is its host's server's to read:
  // its mirror watches the pane, and `wireChatMirror` forwards the desktop's
  // subscriptions to it. This mirror reads this machine's transcripts only.
  const localTranscripts = new LocalTranscriptSource();
  const chatMirror = new ChatMirror({
    agentForPane: (paneId) => {
      const agent = pickPaneAgent(agentManager.getAllAgents(), paneId);
      if (!agent) return null;
      if (agentHostId(agent, getPaneHostId) !== LOCAL_HOST_ID) return null;
      return {
        hostId: agentHostId(agent, getPaneHostId),
        agentKind: agent.agentKind,
        transcriptPath: agent.transcriptPath,
      };
    },
    sourceFor: () => localTranscripts,
    write: (paneId, data) => backend.pty.write(paneId, data),
    publish: (paneId, entry) => bridge.publish("chat", "entry", [paneId, entry], paneId),
    // Keyed by pane and task, so only that task's subscribers hear it.
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
    // `hosts:reconnected` arrives.
    if (isRemoteSessionLoss(hostId, event)) return;
    // A pane on an adopted host is its server's: its bytes reach
    // this server's callers through the host's proxy (`HostRouting.wirePty`),
    // its status is the host's reconciler's, and none of this server's
    // layout, launches or chat holds it. The daemon streams nothing for it
    // here — but for a pane this process attached before the host was
    // adopted, whose bytes still come this way until it is mounted again.
    if (routing?.proxy(hostId)) {
      const watched = "sessionId" in event && routing.watchesPty(event.sessionId);
      if (event.type !== "paneFacts" && !watched) {
        bridge.handleStreamEvent(event);
      }
      return;
    }
    // `paneSessions` is server-derived: cwd and title reach the
    // layout file from the stream, not from a renderer reporting what it saw.
    layoutStore.onPtyEvent(event);
    // A pane's shell is gone: its transcript watcher goes with it,
    // and a setup script's tab closes.
    if (event.type === "exit") {
      chatMirror.closePane(event.sessionId);
      launches.onExit(event.sessionId, event.exitCode);
    }
    // Every daemon's stream events arrive here and only here, so this is
    // where the bridge is fed — the only consumer that
    // forwards, to a renderer window and a paired device alike.
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
      branchWatcher,
      diffWatcher,
      openFileWatcher,
      agentFileAuthors,
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
      notifyProjectsChanged,
      notifier,
      sessionOwners: backendRegistry.sessions,
      hostStatus: (hostId) => backendRegistry.status(hostId),
      ...(routing ? { hostRouting: routing } : {}),
      // The sinks the shared handlers reach the platform through.
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
    ...(hostAdoption ? { hostAdoption } : {}),
  };

  // The caller's deps: the shared parts plus its own.
  const deps = opts.deps(core);

  // The bridge: one table of what this server can
  // do, built once its deps exist. Every transport attaches to it.
  const bridge = new BridgeServer(deps, {
    table: opts.table,
    // A routed call for an adopted host is its server's.
    ...(routing ? { forward: routing } : {}),
    events: bus.subscribe,
    audit: new RemoteAuditLog(path.join(dataDir, "remote-audit.jsonl")),
  });
  const unwireChat = wireChatMirror({ chatMirror }, bridge, bus.subscribe, routing ?? undefined);
  // A remote pane's terminal events, for whoever here views it.
  const unwirePty = routing?.wirePty(bridge) ?? ((): void => {});
  // A connection that closed watches nothing any more.
  const unwireWatchers = bridge.onDisconnect((connectionId) => {
    branchWatcher.stop(connectionId);
    diffWatcher.stop(connectionId);
    openFileWatcher.unwatch(connectionId);
  });

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
      // `ingestHookPayload` — is a Status signal for the reconciler;
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
      unwirePty();
      unwireWatchers();
      branchWatcher.dispose();
      diffWatcher.dispose();
      openFileWatcher.dispose();
      bridge.dispose();
      chatMirror.dispose();
      // Takes down the ssh children; remote sessions keep running on their hosts.
      void backendRegistry.disconnectAll();
      killAllActivePushes();
      statsStore.flushNow();
      agentActivityStore.flush();
      agentActivityStore.dispose();
      worktreeWatcher.dispose();
    },
  };
}
