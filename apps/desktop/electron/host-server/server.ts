/**
 * The host server: a headless Manor server for one remote host,
 * `createManorServer(hostPlatform)` plus what only a host
 * server has — its ownership state, the winsize hold, the daemon retry
 * loop, its hook feed and its always-on relay room. No Electron.
 *
 * It runs beside the `remote` daemon as its own process, and reaches that
 * daemon as a plain local client over `~/.manor/remote/daemon/
 * terminal-host.sock`, the way `remote-bridge` does for the desktop over ssh:
 *
 *   daemon ──stream──▶ hook feed ──▶ AgentHookServer.ingestHookPayload
 *                                   ──▶ Status reconciler ──▶ agents.json
 *          ──stream──▶ pty events ──▶ bridge (pty.*) + chat mirror
 *          ◀─stream── the box's `manor` CLI (`./cli-relay.ts`)
 *   bridge ◀── socket (owner channel, `serve.ts`)
 *          ◀── relay channels, as devices (`./relay.ts`, its own room)
 *
 * **Agents** come from the daemon's hook journal, into the server's agent
 * pipeline: live `hookEvent`s, plus `replayHooks` from the cursor persisted
 * in `dataDir/hook-cursor.json` on every (re)connect (`HostHookFeed`, the
 * same class the desktop runs per remote host). Unlike the desktop, a server that
 * meets the journal for the first time replays all of it rather than
 * starting at its head: the desktop skips history it was never shown, but
 * for this server the journal *is* its history — it was installed after
 * those agents started, and a phone should still see them. A boot-time sweep
 * then abandons the agents whose panes are gone, as the desktop's
 * `agents.reconcileStale` does.
 *
 * **Projects, workspaces and layout** are this server's: the
 * `ProjectManager` and `LayoutStore` `createManorServer` builds, persisted to
 * `dataDir/projects.json` and `dataDir/layout.json`, every project
 * `hostId: "local"`. A device creates workspaces and launches agents here
 * with no owner connected (`./handlers.ts`). Until the desktop has handed
 * over what it held for this host the server is `pending` and refuses those
 * writes (`./ownership.ts`).
 *
 * **The daemon is never replaced** by this server. A daemon restart ends
 * every session, so it is the desktop's call, made through
 * `remote-bridge`; this server upgrades on every release without touching
 * it. A daemon speaking another protocol is reported, not restarted.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentStatusSink } from "../agent-status/pipeline";
import { HostHookFeed } from "../backend/hook-feed";
import type { HostStatus, HostStatusInfo } from "../backend/host-connection";
import { LOCAL_HOST_ID } from "../backend/types";
import { reconcileStaleAgents } from "../bridge/handlers/agents-read";
import { WsBridgeServer } from "../bridge/transports/ws";
import { errorMessage } from "../lib/errors";
import {
  hostServerPaths,
  type DaemonNamespace,
  type HostServerPaths,
} from "../paths";
import type { SecretBox } from "../platform/secret-box";
import type { ServerKeyStatus } from "./secrets-command";
import { createManorServer } from "../server/create-manor-server";
import type { Platform } from "../server/platform";
import type { HostTransport } from "../terminal-host/transport";
import { LocalTransport } from "../terminal-host/transport-local";
import { isActiveStatus } from "../agent-status/reconciler";
import { createAdoption } from "./adopt";
import { createBusyTracker, createHookRunner } from "./busy";
import { serveCliRelay } from "./cli-relay";
import { HOST_TABLE, type HostServerDeps } from "./handlers";
import { createHostWinsize, type HostWinsize } from "./winsize";
import { reportedCapabilities } from "./capabilities";
import {
  checkInstanceIdentity,
  currentInstanceId,
  type IdentityReset,
} from "./instance";
import { fileHookCursorStore } from "./hook-cursor";
import { fileOwnershipState, PENDING_MESSAGE, type OwnershipState } from "./ownership";
import { createSupervisorFactsCache } from "./supervisor";
import {
  createHostRelay,
  type HostRelay,
  type HostRelayOptions,
  type HostServerStatus,
} from "./relay";

/** Why a host server fires no automation before its daemon is caught up. */
const DAEMON_NOT_READY_MESSAGE = "The host's daemon isn't connected yet";

export interface HostServerOptions {
  /** Defaults to `~/.manor/remote/server/` (`remoteServerDir()`). */
  dataDir?: string;
  /** Which of this machine's daemons to reach. Always `remote` in `serve`. */
  daemonNamespace?: DaemonNamespace;
  /** Seals the relay identity, paired devices and push keys. */
  secretBox: SecretBox;
  /** The running app's version: the daemon handshake and the hello reply. */
  appVersion: string;
  /** How the daemon is reached. Defaults to its local socket; tests inject. */
  transport?: HostTransport;
  /**
   * A status transition worth a notification, coalesced across a replay —
   * beside this server's own push, which always hears it.
   */
  onAgentStatus?: AgentStatusSink;
  /** The relay connector and push, for tests (fake relay, injected send). */
  relay?: HostRelayOptions;
  /** Driver clocks, for tests. */
  monoClock?: () => number;
  wallClock?: () => number;
  /**
   * Where `on-busy` and `on-idle` live. Defaults to `hooks/`
   * beside the data dir, which is `~/.manor/remote/hooks/` for the real one.
   */
  hooksDir?: string;
  /** Tests: handed the server's parts once they are built. */
  internals?: (parts: HostServerInternals) => void;
  /**
   * What status reports about the key sealing the pairing keys, computed once at start (`serverKeyStatus`). Absent: no key.
   */
  keyStatus?: ServerKeyStatus;
}

export interface HostServer {
  /**
   * Bring up the relay and connect to the daemon, side by side; resolves
   * once the first hook catch-up has settled, or the first connect failed
   * (it is then retried in the background).
   */
  start(): Promise<void>;
  /** Close every connection, persist agents and the hook cursor, let go. */
  stop(): Promise<void>;
  /**
   * The hello gate over `FrameSocket`s: the owner socket (`serve.ts`) and
   * the relay's channels.
   */
  readonly frames: WsBridgeServer;
  /** What `hostServer.status` answers the owner. */
  status(): HostServerStatus;
}

/** The parts a test reaches past `HostServer` for (`HostServerOptions.internals`). */
export interface HostServerInternals {
  relay: HostRelay;
  /** Flips `pending` to `host` directly, without an adoption. */
  ownership: OwnershipState;
}

/**
 * Slice 1's owner snapshots: the desktop's manifest, and the
 * layout snapshot that `layout.json` held before it was this server's own
 * `LayoutStore` file. Discarded rather than migrated: the desktop still has
 * every record they copied, and hands them over on adoption.
 */
function discardOwnerSnapshots(paths: HostServerPaths): void {
  fs.rmSync(paths.legacyManifest, { force: true });
  let raw: string;
  try {
    raw = fs.readFileSync(paths.layout, "utf-8");
  } catch {
    return;
  }
  try {
    // A snapshot says when the desktop took it; a layout file never does.
    const parsed = JSON.parse(raw) as { takenAt?: unknown };
    if (typeof parsed.takenAt !== "string") return;
  } catch {
    // Unreadable either way: the store starts empty, as it would.
    return;
  }
  console.info(`[host-server] discarding the owner's layout snapshot in ${paths.layout}`);
  fs.rmSync(paths.layout, { force: true });
}

/** Retry the daemon connection at 0.5 s, doubling to 30 s, forever. */
function daemonRetryDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 30_000);
}

/**
 * The daemon's local socket, without the power to replace the daemon. The
 * handshake asks for `restart` only on a protocol mismatch; refusing it here
 * leaves the daemon (and every session on it) to the desktop's
 * `remote-bridge`, and the connect fails until the two match.
 */
function daemonTransport(namespace: DaemonNamespace): HostTransport {
  const local = new LocalTransport({ namespace });
  return {
    ensureRunning: (version) => local.ensureRunning(version),
    restart: async () => {
      throw new Error(
        "the daemon speaks another protocol; the host server never restarts it (the desktop's next connect does)",
      );
    },
    connectControl: () => local.connectControl(),
    connectStream: () => local.connectStream(),
    authToken: () => local.authToken(),
    dispose: () => local.dispose(),
  };
}

export function createHostServer(opts: HostServerOptions): HostServer {
  const paths = hostServerPaths(opts.dataDir);
  fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  const { appVersion } = opts;

  discardOwnerSnapshots(paths);

  const hostPlatform: Platform = {
    dataDir: paths.dataDir,
    layoutFile: paths.layout,
    secretBox: opts.secretBox,
    appVersion,
    hostName: () => os.hostname(),
    daemonTransport:
      opts.transport ?? daemonTransport(opts.daemonNamespace ?? "remote"),
  };

  const startedAt = Date.now();
  // Read from the marker on every status; lingering in the background.
  const supervisorFacts = createSupervisorFactsCache();
  void supervisorFacts.refresh();

  // Whether the desktop has handed this host over yet.
  const ownership = fileOwnershipState(paths.ownership);

  // ── the daemon's connection, as `hosts.list` reports it ──
  /**
   * Set once the daemon's first connect and hook catch-up are done: until
   * then no automation fires, since its session could not start and its
   * overlap check would read agents the catch-up has not settled.
   */
  let daemonReady = false;
  let daemonState: { status: HostStatus; error?: string } = {
    status: "disconnected",
  };
  const daemonStatus = (): HostStatusInfo => ({
    hostId: LOCAL_HOST_ID,
    spec: null,
    ...daemonState,
  });

  // Set by the start-up identity check, until the owner has read it.
  let identityReset: IdentityReset | null = null;

  // Built with the deps, over the server's relay stores.
  let relay!: HostRelay;
  let winsize!: HostWinsize;

  const server = createManorServer<HostServerDeps>(hostPlatform, {
    table: HOST_TABLE,
    // Nothing fires before the desktop hands this host over, nor before the
    // daemon is first reached and caught up.
    automationsBlocked: () => {
      if (ownership.current() !== "host") return PENDING_MESSAGE;
      return daemonReady ? null : DAEMON_NOT_READY_MESSAGE;
    },
    onAgentStatus: (agent, prevStatus, newStatus, about) => {
      relay.onAgentStatus(agent, prevStatus, newStatus, about);
      opts.onAgentStatus?.(agent, prevStatus, newStatus);
    },
    onAutomationRun: (automation, run) => relay.onAutomationRun(automation, run),
    daemonListener: {
      onLost: () => {
        daemonState = { status: "reconnecting" };
        feed.pause();
      },
      // The server resyncs the panes' facts after this.
      onReconnected: () => {
        daemonState = { status: "connected" };
        void feed.catchUp();
      },
    },
    relayStores: {
      identityFile: paths.relayIdentity,
      devicesFile: paths.devices,
      vapidFile: paths.vapid,
      linearTokenFile: paths.linearToken,
      pushSend: opts.relay?.pushSend,
      pushGenerate: opts.relay?.pushGenerate,
    },
    ...(opts.monoClock || opts.wallClock
      ? {
          clocks: {
            ...(opts.monoClock ? { monoClock: opts.monoClock } : {}),
            ...(opts.wallClock ? { wallClock: opts.wallClock } : {}),
          },
        }
      : {}),
    deps: (core) => {
      const { shared } = core;
      // Relay channels pass the device gate, then this server's hello gate
      // (`frames`, below), so the host table's device rules (LOCAL_ONLY
      // refusals) apply to every phone.
      relay = createHostRelay({
        stores: core.relayStores,
        appVersion,
        frames: () => frames,
        notifyOnRequiresInput: () =>
          shared.preferencesManager.get("notifyOnRequiresInput"),
        options: opts.relay,
      });
      winsize = createHostWinsize({
        listSessions: () => core.localBackend.pty.listSessions(),
        // A session this server launched is subscribed with nobody viewing.
        isSubscribed: (sessionId) => core.client.isSubscribed(sessionId),
      });
      return {
        // Every shared part: the shared handlers in the table read them.
        ...shared,
        winsize,
        daemonStatus,
        preferences: () => shared.preferencesManager.getAll(),
        theme: () => shared.themeManager.getThemeByName("__default__"),
        remoteControl: relay.remoteControl,
        relay,
        ownership,
        // The desktop's records for this host, merged in.
        adopt: createAdoption({
          projectManager: shared.projectManager,
          agentManager: shared.agentManager,
          layoutStore: shared.layoutStore,
          ownership,
          publishProjectsChanged: () => core.bus.publish("projects", "changed"),
          publishAgent: (agent) => shared.notifier.sendAgentUpdate(agent),
          reconcileAgents: async () => {
            await reconcileLiveAgents();
          },
        }),
        serverStatus: hostStatus,
        acknowledgeIdentityReset: () => {
          identityReset = null;
        },
        hostName: () => hostPlatform.hostName(),
      };
    },
  });
  const { client, deps, bridge } = server;
  const { agentManager } = server.shared;
  const { shared } = server;

  // ── busy ──
  const hooks = createHookRunner({
    dir: opts.hooksDir ?? path.join(path.dirname(paths.dataDir), "hooks"),
    logFile: path.join(paths.logsDir, "hooks.log"),
  });
  const busy = createBusyTracker({
    isBusy: () =>
      server.agentPipeline.driver.getAllPaneStatuses().some((p) => isActiveStatus(p.status)),
    onChange: (isBusy) => {
      server.bus.publish("hostServer", "busyChanged", { busy: isBusy });
      void hooks.run(isBusy);
    },
  });
  // Every status the reconciler publishes could change the answer...
  const releaseBusyWatch = server.bus.subscribe((b) => {
    if (b.ns === "agents" && b.event === "status") busy.recompute();
  });
  // ...and so can a pane's end, which forgets its state without publishing.
  client.onEvent((event) => {
    if (event.type === "exit") queueMicrotask(() => busy.recompute());
  });

  // The box's `manor` CLI is this server's to answer: it asks
  // the daemon for its requests on every stream (re)connect.
  const releaseCliRelay = serveCliRelay(client, { routes: deps, ownership });
  // The local daemon reconnects quietly on the desktop; a server that has to
  // stay up keeps trying, like a remote host's connection does.
  client.setReconnectPolicy(daemonRetryDelayMs);

  function hostStatus(): HostServerStatus {
    const relayStatus = relay.relayStatus();
    const keyStatus = opts.keyStatus;
    return {
      version: appVersion,
      capabilities: reportedCapabilities(),
      roomId: relayStatus.roomId,
      ownership: ownership.current(),
      uptimeMs: Date.now() - startedAt,
      secretBackend: opts.secretBox.backend(),
      relay: relayStatus,
      devices: relay.deviceCount(),
      pushEndpoints: relay.pushEndpoints(),
      linear: shared.linearManager.isConnected(),
      secretKeyOnVolume: keyStatus?.place === "data-dir",
      ...(keyStatus?.place ? { secretKeyPlace: keyStatus.place, secretKeyFile: keyStatus.keyFile } : {}),
      ...(keyStatus ? { encryptKeyFile: keyStatus.encryptKeyFile } : {}),
      identityReset,
      supervisor: supervisorFacts.current(),
      ...busyState(busy.state()),
      hooks: hooks.available(),
      desktopViewing: server.bridge.hasDesktopViewerSubscriber("pty", "output"),
      viewing: viewingNow(),
    };
  }

  /**
   * Who is watching: a pane's output, and for a phone also an
   * agent's chat, its main view of one.
   */
  function viewingNow(): NonNullable<HostServerStatus["viewing"]> {
    const pty = server.bridge.viewing("pty", "output");
    const entry = server.bridge.viewing("chat", "entry");
    const taskEntry = server.bridge.viewing("chat", "taskEntry");
    return {
      desktop: pty.desktop,
      device: pty.device || entry.device || taskEntry.device,
      forwarded: pty.forwarded,
    };
  }

  const frames = new WsBridgeServer(bridge, {
    appVersion,
    // The box's own name: pairings show it.
    hostName: () => hostPlatform.hostName(),
    // The page reads this, not `hostName`, to know it is on a host server.
    hostServer: true,
  });
  opts.internals?.({ relay, ownership });

  // ── hooks ──
  const cursorStore = fileHookCursorStore(paths.hookCursor, {
    beforeWrite: () => agentManager.flushNow(),
  });
  // A server meeting the journal for the first time replays all of it (see
  // the header).
  const feed = new HostHookFeed({
    hostId: LOCAL_HOST_ID,
    replay: (sinceSeq, replayOpts) => client.replayHooks(sinceSeq, replayOpts),
    store: cursorStore,
    sink: () => server.agentPipeline.hookSink,
    firstContact: "replayAll",
  });

  // The rest of the stream reaches the server's own fan-out, through its
  // backend registry; the journal's hooks are this server's to read.
  client.onEvent((event) => {
    if (event.type === "hookEvent") feed.onLiveEvent(event.seq, event.payload);
  });

  /**
   * Abandon every active agent whose pane the daemon no longer has, over one
   * `listSessions`; the live sessions, or null when the daemon cannot say.
   */
  async function reconcileLiveAgents(): Promise<Array<{ sessionId: string }> | null> {
    let live: Array<{ sessionId: string }>;
    try {
      live = await server.localBackend.pty.listSessions();
    } catch (err) {
      console.debug(
        "[host-server] cannot list sessions to reconcile agents:",
        errorMessage(err),
      );
      return null;
    }
    reconcileStaleAgents(deps, live);
    return live;
  }

  /**
   * The first catch-up's follow-through, over one `listSessions`: abandon
   * every active agent whose pane the daemon no longer has — the desktop's
   * `agents.reconcileStale`; sessions that died while no server was watching
   * left no SessionEnd to say so — then resync the live panes' facts.
   */
  async function afterFirstCatchUp(): Promise<void> {
    const live = await reconcileLiveAgents();
    if (!live) return;
    await server.resyncHostPanes(
      LOCAL_HOST_ID,
      live.map((s) => s.sessionId),
    );
  }

  // ── lifecycle ──
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * A data dir copied from another instance must not share its relay room or
   * keys. Runs once the stores are readable, before the relay
   * dials: a reset that fails leaves the old id recorded and is retried on the
   * next start, with the relay held off until then.
   */
  async function checkIdentity(): Promise<void> {
    identityReset = await checkInstanceIdentity({
      instanceFile: paths.instance,
      currentId: currentInstanceId(),
      resetSealedStores: async () => {
        await relay.resetForClone();
        shared.linearManager.clearToken();
      },
    });
  }

  /**
   * The relay comes up independently of the daemon: a phone may pair and
   * connect while the daemon is still being reached. Never rejects.
   */
  async function startRelay(): Promise<void> {
    try {
      await relay.init();
      await checkIdentity();
      if (!stopped) relay.start();
    } catch (err) {
      console.error("[host-server] relay unavailable:", errorMessage(err));
    }
  }

  /**
   * Connect, then catch up. The catch-up waits for `relayUp` — the relay's
   * stores, read or given up on — so a transition it replays can still be
   * pushed to a phone.
   */
  async function connectLoop(
    relayUp: Promise<void>,
    attempt = 0,
  ): Promise<void> {
    if (stopped) return;
    daemonState = { status: "connecting" };
    try {
      await client.connect();
      if (stopped) return;
      daemonState = { status: "connected" };
      await relayUp;
      await feed.catchUp();
      await afterFirstCatchUp();
      if (!daemonReady && !stopped) {
        daemonReady = true;
        // What came due while blocked fires now, not on the next tick.
        void shared.automations.scheduler.tick();
      }
    } catch (err) {
      if (stopped) return;
      const delay = daemonRetryDelayMs(attempt);
      daemonState = { status: "error", error: errorMessage(err) };
      console.warn(
        `[host-server] cannot reach the daemon (${errorMessage(err)}); retrying in ${delay}ms`,
      );
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void connectLoop(relayUp, attempt + 1);
      }, delay);
    }
  }

  return {
    frames,
    status: hostStatus,

    async start() {
      server.start();
      // The delegated Linear key, decrypted before the first call.
      await shared.linearManager.init();
      const relayUp = startRelay();
      await Promise.all([relayUp, connectLoop(relayUp)]);
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      releaseCliRelay();
      server.agentPipeline.stop();
      releaseBusyWatch();
      busy.dispose();
      feed.pause();
      await relay.stop();
      frames.closeAll();
      winsize.dispose();
      // The bridge, the chat mirror and the server's stores; then a few
      // seconds for automation fires in flight to record their runs.
      await server.stop();
      // agents.json first, then the cursor that says how much of the
      // journal it reflects (`./hook-cursor.ts`).
      agentManager.flushNow();
      cursorStore.flush();
      await client.dispose();
    },
  };
}

/** The busy tracker's state, plus the idle time measured here. */
function busyState(state: { busy: boolean; idleSince: number | null }): {
  busy: boolean;
  idleSince: number | null;
  idleForMs: number | null;
} {
  return {
    ...state,
    idleForMs: state.idleSince === null ? null : Math.max(0, Date.now() - state.idleSince),
  };
}
