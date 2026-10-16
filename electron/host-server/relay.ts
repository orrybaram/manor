/**
 * The host server's own relay room (ADR-225 D3): its relay identity, the
 * phones paired to that room, their push subscriptions, and the connector
 * that dials out to `relay.manor.sh` — the desktop's remote-control runtime
 * (`app-lifecycle.ts` `loadRemoteControlRuntime`), minus the desktop's
 * policies that have no meaning on a box nobody is sitting at.
 *
 *   relay ──channel──▶ RelayGate (device verify, backoff)
 *                        ──▶ the server's hello gate (`frames`)
 *                              ──▶ BridgeServer, as `callerClass: "device"`
 *
 * So a phone on this room is a device to the host table exactly as it is to
 * the desktop's: LOCAL_ONLY methods (pairing, revoke, status, reset) answer
 * `unavailable:host`, and only the owner socket's caller reaches them.
 *
 * **Differences from the desktop's controller, on purpose:**
 *
 * - **Always on.** There is no enable switch: a host server exists to be
 *   reachable with the lid closed. It dials on `start()` and keeps dialling.
 *   The connector reconnects on its own with a capped backoff after a drop;
 *   what it calls final (`failed`: auth refused, replaced by another holder
 *   of this identity, keys unreadable) is retried here on a slow timer,
 *   since nobody is at this box to press Start again.
 * - **No notice for an identity that was replaced.** The desktop's relay
 *   card tells the user; here the stale devices are revoked and logged, and
 *   the desktop learns the device count from `hostServer.status()`.
 *
 * The room operations themselves — pair, revoke, reset, stale-room revokes —
 * are `RelayRoom`'s, shared with the desktop and run one at a time.
 *
 * Secrets go through the host's `SecretBox` (ADR-225 D6) into `dataDir`
 * (`hostServerPaths`). Device tokens are stored as SHA-256 hashes only.
 */

import { WebSocket } from "ws";

import type { WsBridgeServer } from "../bridge/transports/ws";
import { errorMessage } from "../lib/errors";
import type { SecretBackend, SecretKeyPlace } from "../platform/secret-box";
import type {
  PushSubscriptionRecord,
  RemoteDeviceInfo,
  RemoteDeviceStore,
} from "../remote-control/devices";
import {
  pushAgentTransition,
  type PushManager,
  type VapidKeys,
} from "../remote-control/push";
import { RelayGate } from "../remote-control/relay-gate";
import {
  RelayConnector,
  type RelayStatus,
  type RelayTiming,
  type RelayWebSocketCtor,
} from "../remote-control/relay/connector";
import type { RelayIdentityStore } from "../remote-control/relay/identity";
import { RelayRoom, type PairResult } from "../remote-control/relay-room";
import type { AgentStatusSink } from "../agent-status/pipeline";
import type { HostOwnership } from "./ownership";
import type { SupervisorFacts } from "./supervisor/types";

/** How long a relay the connector gave up on waits before it is redialled. */
const FAILED_RETRY_MS = 5 * 60_000;

export interface HostRelayOptions {
  /** Defaults to `resolveRelayUrl()` (`MANOR_RELAY_URL`, else production). */
  relayUrl?: string;
  /** The connector's socket. Defaults to `ws`'s (Node 20 has no global). */
  webSocket?: RelayWebSocketCtor;
  /** Connector timing, for tests. */
  timing?: Partial<RelayTiming>;
  /** After the connector gives up (`failed`), redial this much later. */
  failedRetryMs?: number;
  /**
   * Push's send and key generation, injected so tests reach no push service.
   * The push store is the server's (`createManorServer`'s `relayStores`).
   */
  pushSend?: ConstructorParameters<typeof PushManager>[3];
  pushGenerate?: () => VapidKeys | Promise<VapidKeys>;
}

/** What `hostServer.status()` answers the owner (ADR-225 D4). */
export interface HostServerStatus {
  version: string;
  /**
   * What this server can do beyond slice 2 (ADR-228 D3, D4), such as
   * `"viewer-bridge"`. Optional on the type because an older server's status
   * has none: read it through `hasViewerBridge` (`./capabilities.ts`).
   */
  capabilities?: string[];
  /**
   * This server's relay room — the hash of its relay public key, as the relay
   * addresses it and as a phone's pairing stores it (ADR-228 D2) — or null
   * when its identity cannot be loaded. The same value as `relay.roomId`, at
   * the top level where a desktop's `hosts.list` reads it. Optional on the
   * type for an older server's status.
   */
  roomId?: string | null;
  /**
   * Whether this host's projects, agents and layout are the server's yet
   * (ADR-227 D3): `pending` until the desktop has handed them over.
   */
  ownership: HostOwnership;
  uptimeMs: number;
  /** Which `SecretBox` seals the keys; `plaintext` is warned about (D6). */
  secretBackend: SecretBackend;
  relay: {
    /** This server's room, or null when its identity cannot be loaded. */
    roomId: string | null;
    connected: boolean;
    /** Why the relay is not connected, when the connector knows. */
    error: string | null;
  };
  /** Phones paired to this room. */
  devices: number;
  /**
   * Every push endpoint this server sends to: the desktop suppresses its own
   * push for this host's agents to these (D3, "no duplicate pushes").
   */
  pushEndpoints: string[];
  /** Whether the user turned Linear on for this host: its token is here (ADR-227 D7). */
  linear: boolean;
  /**
   * The key sealing the pairing keys is a file under `~/.manor`, on the very
   * volume it protects (ADR-229 D5). Optional on the type for an older
   * server's status.
   */
  secretKeyOnVolume?: boolean;
  /**
   * Where the key sealing the pairing keys lives (ADR-236 D5): `data-dir`
   * under `~/.manor` (or inline in `supervisor.env`), `home` elsewhere under
   * home, `elsewhere` for a mounted secret or a key from the environment.
   * Absent when no key is set, or from an older server.
   */
  secretKeyPlace?: SecretKeyPlace;
  /** The key file, home shortened to `~`; null for an inline key. */
  secretKeyFile?: string | null;
  /**
   * The key file `manor-host secrets encrypt` would use (`encryptKeyPlan`),
   * home shortened to `~`, for the Hosts page's hint (ADR-236 D5).
   * Computed when the server starts; absent from an older server.
   */
  encryptKeyFile?: string;
  /**
   * Set when this start found the data dir copied from another instance and
   * reset the sealed stores (ADR-229 D6); reported until the owner has read
   * it once.
   */
  identityReset?: "cloned" | null;
  /**
   * What keeps this host's daemon and server running across a reboot
   * (ADR-229 D4), from `supervisor.json`: its kind and, for systemd, whether
   * the user manager lingers (boots without a login). Null when nothing
   * does. Optional on the type for an older server's status.
   */
  supervisor?: SupervisorFacts | null;
  /**
   * Whether any agent on this host is thinking, working or waiting on input
   * (ADR-229 D7), going idle 60 s after the last one stops. Optional on the
   * type for an older server's status.
   */
  busy?: boolean;
  /** Since when the host has been idle (epoch ms, this box's clock); null while busy. */
  idleSince?: number | null;
  /**
   * How long the host has been idle, measured on the box; null while busy.
   * What the desktop's idle stop reads, so a box whose clock is off from the
   * desktop's doesn't stop early or late.
   */
  idleForMs?: number | null;
  /** Which of `~/.manor/remote/hooks/on-busy` and `on-idle` can be run. */
  hooks?: { onBusy: boolean; onIdle: boolean };
  /**
   * Whether a desktop window has a pane of this host mounted: its viewer
   * stream is subscribed to a pane's output. The desktop's idle stop waits
   * for this to be false.
   */
  desktopViewing?: boolean;
  /**
   * Who is watching (ADR-230 D1): `desktop` a window's viewer stream,
   * `device` a phone (a pane's output, or an agent's chat), `forwarded` main
   * relaying a pane for another window. Absent on an older host.
   */
  viewing?: { desktop: boolean; device: boolean; forwarded: boolean };
}

/** The `remoteControl.*` surface the host table exposes. */
export interface HostRemoteControl {
  /** Resolves once the device is on disk. */
  pair(label: string): Promise<PairResult>;
  listDevices(): RemoteDeviceInfo[];
  /** Resolves once the revoke is on disk; rejects when it could not be saved. */
  revoke(id: string): Promise<RemoteDeviceInfo[]>;
  vapidPublicKey(): Promise<string | null>;
  subscribePush(
    deviceId: string,
    subscription: PushSubscriptionRecord,
  ): boolean;
}

export interface HostRelay {
  readonly remoteControl: HostRemoteControl;
  /**
   * Decrypt the stores (creating the identity on first run). Rejects, and the
   * relay stays off, when the secret box could not run: the stores are left
   * as they are on disk rather than started over.
   */
  init(): Promise<void>;
  /** Dial the relay, and keep dialling until `stop()`. */
  start(): void;
  /** Hang up, close every device connection, persist the stores. */
  stop(): Promise<void>;
  /** A status transition: pushed to subscribed phones if worth it. */
  onAgentStatus: AgentStatusSink;
  relayStatus(): HostServerStatus["relay"];
  deviceCount(): number;
  pushEndpoints(): string[];
  /**
   * Adopt the desktop's VAPID pair (ADR-225 D3). True when the key changed,
   * in which case the subscriptions made against the old one were cleared.
   */
  setVapidKeys(keys: VapidKeys): Promise<boolean>;
  /**
   * New relay identity, so a new room; every device and with it every push
   * subscription revoked; the connector redialled to the new room. The
   * recovery step for a box that may be compromised (ADR-225 D6).
   */
  resetIdentity(): Promise<void>;
  /**
   * `resetIdentity`, and a new VAPID pair too: what a copied data dir needs
   * (ADR-229 D6). The caller clears the Linear token.
   */
  resetForClone(): Promise<void>;
}

export interface HostRelayDeps {
  /**
   * The room's sealed stores, built by `createManorServer` over this host's
   * `SecretBox` in `dataDir` (`hostServerPaths`). Decrypted by `init()`.
   */
  stores: {
    identity: RelayIdentityStore;
    devices: RemoteDeviceStore;
    push: PushManager;
  };
  /** The version segment of pairing links (`/app/<version>/`). */
  appVersion: string;
  /**
   * The server's hello gate over `FrameSocket`s. A getter: the gate is built
   * over the bridge, whose deps hold this relay, so it exists only once this
   * relay does. Read no earlier than the first channel, revoke or `stop()`.
   */
  frames: () => Pick<WsBridgeServer, "attach" | "closeDevice" | "closeAll">;
  /** The user's "agent needs input" preference, read per transition. */
  notifyOnRequiresInput: () => boolean;
  options?: HostRelayOptions;
}

export function createHostRelay(deps: HostRelayDeps): HostRelay {
  const { options = {} } = deps;
  const { identity, devices, push } = deps.stores;
  const gate = new RelayGate(devices, {
    attach: (socket, authenticate) => deps.frames().attach(socket, authenticate),
    closeDevice: (deviceId) => deps.frames().closeDevice(deviceId),
    closeAll: () => deps.frames().closeAll(),
  });
  const connector = new RelayConnector({
    identity,
    gate,
    relayUrl: options.relayUrl,
    webSocket: options.webSocket ?? WebSocket,
    timing: options.timing,
  });

  const room = new RelayRoom({
    devices,
    gate: () => gate,
    relay: () => ({ connector, identity }),
    appVersion: deps.appVersion,
    // No relay card here to tell; the desktop sees the device count drop.
    onStaleRevoked: (count) => {
      console.warn(
        `[host-server] relay identity changed; revoked ${count} device(s) paired to the old room`,
      );
    },
  });

  let running = false;
  /**
   * Set once `init()` has read every store. Until then (or for good, when the
   * secret box could not run) nothing here touches them, and the status
   * reports why.
   */
  let ready = false;
  let initError: string | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const failedRetryMs = options.failedRetryMs ?? FAILED_RETRY_MS;

  const clearRetry = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  connector.onStatus((status: RelayStatus) => {
    if (status.state !== "failed" || !running || retryTimer !== null) return;
    console.warn(
      `[host-server] relay failed (${status.error ?? "unknown"}); retrying in ${failedRetryMs}ms`,
    );
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (running) connector.start();
    }, failedRetryMs);
    retryTimer.unref?.();
  });

  const roomIdOrNull = (): string | null => {
    try {
      return identity.describe().roomId;
    } catch {
      return null;
    }
  };

  const remoteControl: HostRemoteControl = {
    pair: (label) => room.pair(label),
    listDevices: () => devices.list(),
    async revoke(id) {
      await room.revoke(id);
      return devices.list();
    },
    vapidPublicKey: () => push.publicKey(),
    subscribePush: (deviceId, subscription) =>
      push.subscribe(deviceId, subscription),
  };

  return {
    remoteControl,

    async init() {
      try {
        await Promise.all([identity.init(), devices.init(), push.init()]);
      } catch (err) {
        initError = `pairing keys could not be read: ${errorMessage(err)}`;
        throw err;
      }
      initError = null;
      ready = true;
      // An identity that could not be read was replaced by a new one (a new
      // room); every device paired to the old room holds a dead link.
      const roomId = roomIdOrNull();
      if (roomId !== null) await room.revokeStale(roomId);
    },

    start() {
      if (running) return;
      running = true;
      gate.open();
      connector.start();
    },

    async stop() {
      running = false;
      clearRetry();
      // The relay first, so nothing new arrives while the rest closes.
      connector.stop();
      gate.close();
      // A failed write already rejected the pair or revoke that made it; here
      // it is logged so the rest of shutdown still runs.
      await Promise.all([identity.flush(), devices.flush()]).catch(
        (err: unknown) => {
          console.error(
            "[host-server] could not persist relay state:",
            errorMessage(err),
          );
        },
      );
    },

    onAgentStatus(agent, prevStatus, newStatus) {
      if (!ready || !deps.notifyOnRequiresInput()) return;
      pushAgentTransition(push, agent, prevStatus, newStatus);
    },

    relayStatus() {
      const status = connector.status;
      return {
        roomId: roomIdOrNull(),
        connected: status.state === "running",
        error: initError ?? status.error,
      };
    },

    deviceCount: () => (ready ? devices.ids().length : 0),

    pushEndpoints: () =>
      ready
        ? devices.pushTargets().map((target) => target.subscription.endpoint)
        : [],

    setVapidKeys: (keys) => push.importKeys(keys),

    resetIdentity() {
      // A pending redial would dial the room being replaced.
      clearRetry();
      // Back on the air either way; a reset that was not saved rejects.
      return room.reset({ redial: () => running });
    },

    async resetForClone() {
      await this.resetIdentity();
      await push.reset();
    },
  };
}
