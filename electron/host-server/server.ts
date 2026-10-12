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
 *   bridge ◀── socket (owner channel, `serve.ts`), relay (ticket 3)
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
 * here, from the manifest and layout snapshot it pushes (`./manifest.ts`,
 * `./layout.ts`; the push itself is ticket 4).
 *
 * **The daemon is never replaced** by this server. A daemon restart ends
 * every session (ADR-185), so it is the desktop's call, made through
 * `remote-bridge`; this server upgrades on every release without touching
 * it. A daemon speaking another protocol is reported, not restarted.
 */

import fs from "node:fs";
import { dispatchStreamEvent } from "../agent-stream-events";
import { HostHookFeed } from "../backend/hook-feed";
import { createLocalBackend } from "../backend/host-backend";
import type { HostStatus, HostStatusInfo } from "../backend/host-connection";
import { LOCAL_HOST_ID } from "../backend/types";
import { wireChatMirror } from "../bridge/handlers/chat";
import { BridgeServerCore } from "../bridge/server-core";
import { WsBridgeServer } from "../bridge/transports/ws";
import { UNAVAILABLE_HOST_CODE } from "../bridge/types";
import { ChatMirror, pickPaneAgent } from "../chat-mirror/mirror";
import { LocalTranscriptSource } from "../chat-mirror/transcript-source";
import { errorMessage } from "../lib/errors";
import {
  hostServerPaths,
  type DaemonNamespace,
  type HostServerPaths,
} from "../paths";
import type { AppInfo } from "../platform/app-info";
import type { SecretBox } from "../platform/secret-box";
import { PreferencesManager } from "../preferences";
import { RemoteAuditLog } from "../remote-control/audit";
import { TerminalHostClient } from "../terminal-host/client";
import type { HostTransport } from "../terminal-host/transport";
import { LocalTransport } from "../terminal-host/transport-local";
import { ThemeManager } from "../theme";
import {
  createHostAgents,
  type AgentStatusSink,
  type HostAgents,
} from "./agents";
import { HOST_TABLE, type HostServerDeps } from "./handlers";
import { fileHookCursorStore } from "./hook-cursor";
import { readLayoutSnapshot } from "./layout";
import { manifestProjects, readManifest } from "./manifest";

export interface HostServerOptions {
  /** Defaults to `~/.manor/remote/server/` (`remoteServerDir()`). */
  dataDir?: string;
  /** Which of this machine's daemons to reach. Always `remote` in `serve`. */
  daemonNamespace?: DaemonNamespace;
  /**
   * Seals the relay identity and push keys (ADR-218 D6). Unused until the
   * relay arrives (ticket 3), which builds its stores over it.
   */
  secretBox: SecretBox;
  appInfo: AppInfo;
  /** How the daemon is reached. Defaults to its local socket; tests inject. */
  transport?: HostTransport;
  /** A status transition worth a notification (ticket 3: push). */
  onAgentStatus?: AgentStatusSink;
  /** Driver clocks, for tests. */
  monoClock?: () => number;
  wallClock?: () => number;
}

export interface HostServer {
  /** Connect to the daemon (retrying in the background) and start the tick. */
  start(): Promise<void>;
  /** Close every connection, persist agents and the hook cursor, let go. */
  stop(): Promise<void>;
  /** The dispatcher every transport attaches to. */
  readonly bridge: BridgeServerCore<HostServerDeps>;
  /**
   * The hello gate over `FrameSocket`s: the owner socket (`serve.ts`) and,
   * in ticket 3, the relay's channels.
   */
  readonly frames: WsBridgeServer;
  readonly paths: HostServerPaths;
  readonly secretBox: SecretBox;
  /** The agents side, for tests and the relay's push (ticket 3). */
  readonly agents: HostAgents;
  /** Resolves once the first hook catch-up after `start()` has settled. */
  whenCaughtUp(): Promise<void>;
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
  const { appInfo } = opts;

  const client = new TerminalHostClient(
    appInfo.version,
    opts.transport ?? daemonTransport(opts.daemonNamespace ?? "remote"),
  );
  // The local daemon reconnects quietly on the desktop; a server that has to
  // stay up keeps trying, like a remote host's connection does.
  client.setReconnectPolicy(daemonRetryDelayMs);
  const daemon = createLocalBackend(client);

  let bridge: BridgeServerCore<HostServerDeps> | null = null;
  let chatMirror: ChatMirror | null = null;

  const agents = createHostAgents({
    dataDir: paths.dataDir,
    onAgentStatus: opts.onAgentStatus,
    onHook: (event) => chatMirror?.poke(event.paneId),
    monoClock: opts.monoClock,
    wallClock: opts.wallClock,
  });
  const { agentManager, driver } = agents;

  const localTranscripts = new LocalTranscriptSource();
  chatMirror = new ChatMirror({
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
      bridge?.publishKeyed("chat", "entry", [paneId, entry], paneId),
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

  const preferences = new PreferencesManager(paths.dataDir);
  const theme = new ThemeManager();

  const deps: HostServerDeps = {
    backend: { pty: daemon.pty },
    daemonStatus,
    agentManager,
    agentStatus: driver,
    unseenRespondedAgents: agents.unseenRespondedAgents,
    unseenInputAgents: agents.unseenInputAgents,
    chatMirror,
    projects: () => manifestProjects(readManifest(paths.manifest), daemon.git),
    layout: () => readLayoutSnapshot(paths.layout),
    preferences: () => preferences.getAll(),
    theme: () => theme.getThemeByName("__default__"),
  };

  bridge = new BridgeServerCore(deps, {
    table: HOST_TABLE,
    unavailableCode: UNAVAILABLE_HOST_CODE,
    audit: new RemoteAuditLog(`${paths.dataDir}/remote-audit.jsonl`),
  });
  const frames = new WsBridgeServer(bridge, { appVersion: appInfo.version });
  const unwireChat = wireChatMirror({ chatMirror }, bridge);

  // ── hooks ──
  const cursorStore = fileHookCursorStore(paths.hookCursor, {
    beforeWrite: () => agentManager.flushNow(),
  });
  let feed: HostHookFeed | null = null;

  client.onEvent((event) => {
    if (event.type === "hookEvent") {
      feed?.onLiveEvent(event.seq, event.payload);
      return;
    }
    if (event.type === "controlRequest") return;
    if (event.type === "exit") chatMirror?.closePane(event.sessionId);
    dispatchStreamEvent(
      event,
      {
        agentManager,
        agentStatus: driver,
        broadcastAgent: agents.broadcastAgent,
      },
      (e) => bridge?.handleStreamEvent(e),
    );
  });

  client.setConnectionListener({
    onLost: () => {
      daemonState = { status: "reconnecting" };
      feed?.pause();
    },
    onReconnected: ({ sessionIds }) => {
      daemonState = { status: "connected" };
      void feed?.catchUp();
      void resyncPaneFacts(sessionIds);
    },
  });

  /**
   * The feed, built on first connect: a server meeting the journal for the
   * first time starts its cursor at seq 0 of the journal's epoch, so the
   * catch-up replays every hook the journal still holds (see the header).
   */
  async function ensureFeed(): Promise<HostHookFeed> {
    if (feed) return feed;
    if (cursorStore.get(LOCAL_HOST_ID) === null) {
      const head = await client.replayHooks(0, { headOnly: true });
      cursorStore.set(LOCAL_HOST_ID, { seq: 0, epoch: head.epoch });
    }
    feed = new HostHookFeed({
      hostId: LOCAL_HOST_ID,
      replay: (sinceSeq, replayOpts) =>
        client.replayHooks(sinceSeq, replayOpts),
      store: cursorStore,
      sink: () => agents.hookSink,
    });
    return feed;
  }

  async function resyncPaneFacts(
    sessionIds?: readonly string[],
  ): Promise<void> {
    try {
      const ids =
        sessionIds ?? (await daemon.pty.listSessions()).map((s) => s.sessionId);
      await driver.resync(ids, (id) => daemon.pty.getPaneFacts(id));
    } catch (err) {
      console.debug(
        "[host-server] pane facts resync failed:",
        errorMessage(err),
      );
    }
  }

  /**
   * Abandon every active agent whose pane the daemon no longer has: the
   * desktop's `agents.reconcileStale`, run once when this server first
   * catches up. Sessions that died while no server was watching left no
   * SessionEnd to say so.
   */
  async function sweepStaleAgents(): Promise<void> {
    let live: Set<string>;
    try {
      live = new Set((await daemon.pty.listSessions()).map((s) => s.sessionId));
    } catch {
      return;
    }
    for (const agent of agentManager.getAllAgents()) {
      if (agent.status !== "active" || !agent.paneId) continue;
      if (live.has(agent.paneId)) continue;
      if (agent.lastAgentStatus === "responded") continue;
      if (driver.isPaneLossExpected(agent.paneId)) continue;
      driver.signal(agent.paneId, { type: "user", action: "abandon" });
    }
  }

  // ── lifecycle ──
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let markCaughtUp: () => void = () => {};
  const caughtUp = new Promise<void>((resolve) => {
    markCaughtUp = resolve;
  });

  async function connectLoop(attempt = 0): Promise<void> {
    if (stopped) return;
    daemonState = { status: "connecting" };
    try {
      await client.connect();
      const hookFeed = await ensureFeed();
      if (stopped) return;
      daemonState = { status: "connected" };
      await hookFeed.catchUp();
      await sweepStaleAgents();
      await resyncPaneFacts();
      markCaughtUp();
    } catch (err) {
      if (stopped) return;
      const delay = daemonRetryDelayMs(attempt);
      daemonState = { status: "error", error: errorMessage(err) };
      console.warn(
        `[host-server] cannot reach the daemon (${errorMessage(err)}); retrying in ${delay}ms`,
      );
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void connectLoop(attempt + 1);
      }, delay);
    }
  }

  return {
    bridge,
    frames,
    paths,
    secretBox: opts.secretBox,
    agents,
    whenCaughtUp: () => caughtUp,

    async start() {
      driver.start();
      await connectLoop();
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      driver.stop();
      feed?.pause();
      frames.closeAll();
      unwireChat();
      bridge?.dispose();
      chatMirror?.dispose();
      // agents.json first, then the cursor that says how much of the
      // journal it reflects (`./hook-cursor.ts`).
      agentManager.flushNow();
      cursorStore.flush();
      await client.dispose();
    },
  };
}
