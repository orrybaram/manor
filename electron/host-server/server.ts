/**
 * The host server (ADR-218 D1): a headless Manor server for one remote host,
 * composed from the parts the desktop's `initApp()` uses, with no Electron.
 *
 * It runs beside the `remote` daemon as its own process, and reaches that
 * daemon as a plain local client over `~/.manor/remote/daemon/
 * terminal-host.sock`, the way `remote-bridge` does for the desktop over ssh:
 *
 *   daemon ──stream──▶ hook feed ──▶ AgentHookServer.ingestHookPayload
 *                                   ──▶ Status reconciler ──▶ agents.json
 *          ──stream──▶ pty events ──▶ bridge (pty.*) + chat mirror
 *   bridge ◀── socket (owner channel, `serve.ts`)
 *          ◀── relay channels, as devices (`./relay.ts`, its own room)
 *
 * **Agents** come from the daemon's hook journal (`./agents.ts`): live
 * `hookEvent`s, plus `replayHooks` from the cursor persisted in
 * `dataDir/hook-cursor.json` on every (re)connect (`HostHookFeed`, the same
 * class the desktop runs per remote host). Unlike the desktop, a server that
 * meets the journal for the first time replays all of it rather than
 * starting at its head: the desktop skips history it was never shown, but
 * for this server the journal *is* its history — it was installed after
 * those agents started, and a phone should still see them. A boot-time sweep
 * then abandons the agents whose panes are gone, as the desktop's
 * `agents.reconcileStale` does.
 *
 * **Projects and layout** are the desktop's in slice 1 and are only read
 * here, from the manifest and layout snapshot it pushes over the owner
 * channel (`./manifest.ts`, `./layout.ts`, `./owner.ts`).
 *
 * **The daemon is never replaced** by this server. A daemon restart ends
 * every session (ADR-185), so it is the desktop's call, made through
 * `remote-bridge`; this server upgrades on every release without touching
 * it. A daemon speaking another protocol is reported, not restarted.
 */

import fs from "node:fs";
import os from "node:os";
import { dispatchStreamEvent } from "../agent-stream-events";
import { resyncPaneFacts } from "../agent-status/pipeline";
import { HostHookFeed } from "../backend/hook-feed";
import { createLocalBackend } from "../backend/host-backend";
import type { HostStatus, HostStatusInfo } from "../backend/host-connection";
import { LOCAL_HOST_ID } from "../backend/types";
import { reconcileStaleAgents } from "../bridge/handlers/agents-read";
import { wireChatMirror } from "../bridge/handlers/chat";
import { BridgeServer } from "../bridge/server";
import { WsBridgeServer } from "../bridge/transports/ws";
import { ChatMirror, pickPaneAgent } from "../chat-mirror/mirror";
import { LocalTranscriptSource } from "../chat-mirror/transcript-source";
import { errorMessage } from "../lib/errors";
import { hostServerPaths, type DaemonNamespace } from "../paths";
import type { SecretBox } from "../platform/secret-box";
import { PreferencesManager } from "../preferences";
import { RemoteAuditLog } from "../remote-control/audit";
import { createBroadcastBus } from "../renderer-broadcast";
import { TerminalHostClient } from "../terminal-host/client";
import type { HostTransport } from "../terminal-host/transport";
import { LocalTransport } from "../terminal-host/transport-local";
import { ThemeManager } from "../theme";
import { createHostAgents, type AgentStatusSink } from "./agents";
import { HOST_TABLE, type HostServerDeps } from "./handlers";
import { createHostWinsize } from "./winsize";
import { createOwnerSync, paneContextFrom } from "./owner";
import { OwnerSnapshotStore } from "./owner-snapshot";
import { fileHookCursorStore } from "./hook-cursor";
import { manifestProjects } from "./manifest";
import {
  createHostRelay,
  type HostRelay,
  type HostRelayOptions,
  type HostServerStatus,
} from "./relay";

export interface HostServerOptions {
  /** Defaults to `~/.manor/remote/server/` (`remoteServerDir()`). */
  dataDir?: string;
  /** Which of this machine's daemons to reach. Always `remote` in `serve`. */
  daemonNamespace?: DaemonNamespace;
  /** Seals the relay identity, paired devices and push keys (ADR-218 D6). */
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
  /** Tests: handed the server's parts once they are built. */
  internals?: (parts: HostServerInternals) => void;
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
  /** What `hostServer.status` answers the owner (ADR-218 D4). */
  status(): HostServerStatus;
}

/** The parts a test reaches past `HostServer` for (`HostServerOptions.internals`). */
export interface HostServerInternals {
  relay: HostRelay;
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

  const client = new TerminalHostClient(
    appVersion,
    opts.transport ?? daemonTransport(opts.daemonNamespace ?? "remote"),
  );
  // The local daemon reconnects quietly on the desktop; a server that has to
  // stay up keeps trying, like a remote host's connection does.
  client.setReconnectPolicy(daemonRetryDelayMs);
  const daemon = createLocalBackend(client);

  // This server's keyless pushes — agents, the owner's syncs — heard by its
  // bridge and chat mirror and nobody else in the process.
  const events = createBroadcastBus();
  const preferences = new PreferencesManager(paths.dataDir);
  const theme = new ThemeManager();
  const startedAt = Date.now();

  // What the owner last synced (ADR-218 D4, D5), read once and held.
  const snapshots = new OwnerSnapshotStore(paths);
  const ownerSync = createOwnerSync({ store: snapshots, publish: events.publish });

  // Relay channels pass the device gate, then this server's hello gate
  // (`frames`, below), so the host table's device rules (LOCAL_ONLY
  // refusals) apply to every phone.
  const relay = createHostRelay({
    paths,
    secretBox: opts.secretBox,
    appVersion,
    frames: () => frames,
    notifyOnRequiresInput: () => preferences.get("notifyOnRequiresInput"),
    options: opts.relay,
  });

  const agents = createHostAgents({
    dataDir: paths.dataDir,
    publish: events.publish,
    // A new agent's project, from the owner's last manifest and layout.
    getPaneContext: (paneId) =>
      paneContextFrom(snapshots.manifest(), snapshots.layout(), paneId),
    onAgentStatus: (agent, prevStatus, newStatus) => {
      relay.onAgentStatus(agent, prevStatus, newStatus);
      opts.onAgentStatus?.(agent, prevStatus, newStatus);
    },
    onHook: (event) => chatMirror.poke(event.paneId),
    monoClock: opts.monoClock,
    wallClock: opts.wallClock,
  });
  const { agentManager, driver } = agents;

  const localTranscripts = new LocalTranscriptSource();
  const chatMirror = new ChatMirror({
    agentForPane: (paneId) => {
      const agent = pickPaneAgent(agentManager.getAllAgents(), paneId);
      return agent
        ? { hostId: LOCAL_HOST_ID, transcriptPath: agent.transcriptPath }
        : null;
    },
    // Transcripts are files on this box.
    sourceFor: () => localTranscripts,
    write: (paneId, data) => daemon.pty.write(paneId, data),
    publish: (paneId, entry) =>
      bridge.publish("chat", "entry", [paneId, entry], paneId),
  });

  // ── the daemon's connection, as `hosts.list` reports it ──
  let daemonState: { status: HostStatus; error?: string } = {
    status: "disconnected",
  };
  const daemonStatus = (): HostStatusInfo => ({
    hostId: LOCAL_HOST_ID,
    spec: null,
    ...daemonState,
  });

  const hostStatus = (): HostServerStatus => ({
    version: appVersion,
    uptimeMs: Date.now() - startedAt,
    secretBackend: opts.secretBox.backend(),
    relay: relay.relayStatus(),
    devices: relay.deviceCount(),
    pushEndpoints: relay.pushEndpoints(),
  });

  const winsize = createHostWinsize({
    listSessions: () => daemon.pty.listSessions(),
  });

  const deps: HostServerDeps = {
    backend: { pty: daemon.pty },
    winsize,
    daemonStatus,
    agentManager,
    agentStatus: driver,
    unseenRespondedAgents: agents.unseenRespondedAgents,
    unseenInputAgents: agents.unseenInputAgents,
    chatMirror,
    projects: () => manifestProjects(snapshots.manifest(), daemon.git),
    layout: () => snapshots.layout(),
    preferences: () => preferences.getAll(),
    theme: () => theme.getThemeByName("__default__"),
    remoteControl: relay.remoteControl,
    relay,
    ownerSync,
    serverStatus: hostStatus,
  };

  const bridge = new BridgeServer(deps, {
    table: HOST_TABLE,
    events: events.subscribe,
    audit: new RemoteAuditLog(`${paths.dataDir}/remote-audit.jsonl`),
  });
  const frames = new WsBridgeServer(bridge, {
    appVersion,
    // The desktop's name for this host wins; else the box's own (ADR-218 D7).
    hostName: () => snapshots.manifest().hostName ?? os.hostname(),
    // The page reads this, not `hostName`, to know it is on a host server.
    hostServer: true,
  });
  const unwireChat = wireChatMirror({ chatMirror }, bridge, events.subscribe);
  opts.internals?.({ relay });

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
    sink: () => agents.hookSink,
    firstContact: "replayAll",
  });

  client.onEvent((event) => {
    if (event.type === "hookEvent") {
      feed.onLiveEvent(event.seq, event.payload);
      return;
    }
    if (event.type === "controlRequest") return;
    if (event.type === "exit") chatMirror.closePane(event.sessionId);
    dispatchStreamEvent(
      event,
      {
        agentManager,
        agentStatus: driver,
        broadcastAgent: agents.broadcastAgent,
      },
      (e) => bridge.handleStreamEvent(e),
    );
  });

  client.setConnectionListener({
    onLost: () => {
      daemonState = { status: "reconnecting" };
      feed.pause();
    },
    onReconnected: ({ sessionIds }) => {
      daemonState = { status: "connected" };
      void feed.catchUp();
      void resyncPanes(sessionIds);
    },
  });

  /** Resync pane facts; a daemon that cannot be asked is retried on reconnect. */
  async function resyncPanes(sessionIds?: readonly string[]): Promise<void> {
    try {
      await resyncPaneFacts(daemon.pty, driver, sessionIds);
    } catch (err) {
      console.debug(
        "[host-server] pane facts resync failed:",
        errorMessage(err),
      );
    }
  }

  /**
   * The first catch-up's follow-through, over one `listSessions`: abandon
   * every active agent whose pane the daemon no longer has — the desktop's
   * `agents.reconcileStale`; sessions that died while no server was watching
   * left no SessionEnd to say so — then resync the live panes' facts.
   */
  async function afterFirstCatchUp(): Promise<void> {
    let live: Array<{ sessionId: string }>;
    try {
      live = await daemon.pty.listSessions();
    } catch (err) {
      console.debug(
        "[host-server] cannot list sessions after catch-up:",
        errorMessage(err),
      );
      return;
    }
    reconcileStaleAgents(deps, live);
    await resyncPanes(live.map((s) => s.sessionId));
  }

  // ── lifecycle ──
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The relay comes up independently of the daemon: a phone may pair and
   * connect while the daemon is still being reached. Never rejects.
   */
  async function startRelay(): Promise<void> {
    try {
      await relay.init();
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
      agents.start();
      const relayUp = startRelay();
      await Promise.all([relayUp, connectLoop(relayUp)]);
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      agents.stop();
      feed.pause();
      await relay.stop();
      frames.closeAll();
      unwireChat();
      winsize.dispose();
      bridge.dispose();
      chatMirror.dispose();
      // agents.json first, then the cursor that says how much of the
      // journal it reflects (`./hook-cursor.ts`).
      agentManager.flushNow();
      cursorStore.flush();
      await client.dispose();
    },
  };
}
