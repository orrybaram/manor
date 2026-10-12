/**
 * The host server's own relay room (ADR-218 D3): its relay identity, the
 * phones paired to that room, their push subscriptions, and the connector
 * that dials out to `relay.manor.sh` — the desktop's remote-control runtime
 * (`app-lifecycle.ts` `loadRemoteControlRuntime`), minus the desktop's
 * policies that have no meaning on a box nobody is sitting at.
 *
 *   relay ──channel──▶ RelayGate (device verify, backoff)
 *                        ──▶ the server's hello gate (`frames`)
 *                              ──▶ BridgeServerCore, as `callerClass: "device"`
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
 * Secrets go through the host's `SecretBox` (ADR-218 D6) into `dataDir`
 * (`hostServerPaths`). Device tokens are stored as SHA-256 hashes only.
 */

import { WebSocket } from "ws";

import type { WsBridgeServer } from "../bridge/transports/ws";
import { errorMessage } from "../lib/errors";
import type { HostServerPaths } from "../paths";
import type { SecretBackend, SecretBox } from "../platform/secret-box";
import type { PairResult } from "../remote-control/controller";
import {
  RemoteDeviceStore,
  type PushSubscriptionRecord,
  type RemoteDeviceInfo,
} from "../remote-control/devices";
import {
  PushManager,
  pushAgentTransition,
  type VapidKeys,
} from "../remote-control/push";
import { RelayGate } from "../remote-control/relay-gate";
import {
  RelayConnector,
  type RelayStatus,
  type RelayTiming,
  type RelayWebSocketCtor,
} from "../remote-control/relay/connector";
import { RelayIdentityStore } from "../remote-control/relay/identity";
import { relayPairingUrl } from "../remote-control/relay/url";
import type { AgentStatusSink } from "./agents";

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
  /** Push's send and key generation, injected so tests reach no push service. */
  pushSend?: ConstructorParameters<typeof PushManager>[3];
  pushGenerate?: () => VapidKeys | Promise<VapidKeys>;
}

/** What `hostServer.status()` answers the owner (ADR-218 D4). */
export interface HostServerStatus {
  version: string;
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
}

/** The `remoteControl.*` surface the host table exposes. */
export interface HostRemoteControl {
  pair(label: string): PairResult;
  listDevices(): RemoteDeviceInfo[];
  revoke(id: string): RemoteDeviceInfo[];
  vapidPublicKey(): Promise<string | null>;
  subscribePush(
    deviceId: string,
    subscription: PushSubscriptionRecord,
  ): boolean;
}

export interface HostRelay {
  readonly remoteControl: HostRemoteControl;
  /** Decrypt the stores (creating the identity on first run). */
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
   * Adopt the desktop's VAPID pair (ADR-218 D3). True when the key changed,
   * in which case the subscriptions made against the old one were cleared.
   */
  setVapidKeys(keys: VapidKeys): Promise<boolean>;
  /**
   * New relay identity, so a new room; every device and with it every push
   * subscription revoked; the connector redialled to the new room. The
   * recovery step for a box that may be compromised (ADR-218 D6).
   */
  resetIdentity(): Promise<void>;
}

export interface HostRelayDeps {
  paths: HostServerPaths;
  secretBox: SecretBox;
  /** The version segment of pairing links (`/app/<version>/`). */
  appVersion: string;
  /** The server's hello gate over `FrameSocket`s. */
  frames: Pick<WsBridgeServer, "attach" | "closeDevice" | "closeAll">;
  /** The user's "agent needs input" preference, read per transition. */
  notifyOnRequiresInput: () => boolean;
  options?: HostRelayOptions;
}

export function createHostRelay(deps: HostRelayDeps): HostRelay {
  const { paths, secretBox, options = {} } = deps;
  const identity = new RelayIdentityStore(secretBox, paths.relayIdentity);
  const devices = new RemoteDeviceStore(secretBox, paths.devices);
  const push = new PushManager(
    devices,
    secretBox,
    paths.vapid,
    options.pushSend,
    options.pushGenerate,
  );
  const gate = new RelayGate(devices, deps.frames);
  const connector = new RelayConnector({
    identity,
    gate,
    relayUrl: options.relayUrl,
    webSocket: options.webSocket ?? WebSocket,
    timing: options.timing,
  });

  let running = false;
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

  const revokeAll = (ids: readonly string[]): void => {
    for (const id of ids) {
      devices.revoke(id);
      gate.closeDevice(id);
    }
  };

  const remoteControl: HostRemoteControl = {
    pair(label) {
      const origin = connector.origin;
      if (!origin) throw new Error("The relay address is not configured.");
      const { roomId, x25519Pub } = identity.describe();
      const { device, rawToken } = devices.pair(label, roomId);
      return {
        device,
        rawToken,
        pairingUrl: relayPairingUrl({
          origin,
          appVersion: deps.appVersion,
          roomId,
          x25519Pub,
          rawToken,
        }),
      };
    },
    listDevices: () => devices.list(),
    revoke(id) {
      // Revoke means now: the store stops new hellos, the gate closes the
      // device's live channels.
      revokeAll([id]);
      return devices.list();
    },
    vapidPublicKey: () => push.publicKey(),
    subscribePush: (deviceId, subscription) =>
      push.subscribe(deviceId, subscription),
  };

  return {
    remoteControl,

    async init() {
      await Promise.all([identity.init(), devices.init()]);
      // An identity that could not be read was replaced by a new one (a new
      // room); every device paired to the old room holds a dead link.
      const roomId = roomIdOrNull();
      if (roomId === null) return;
      const stale = devices.idsInOtherRelayRooms(roomId);
      if (stale.length > 0) {
        console.warn(
          `[host-server] relay identity changed; revoking ${stale.length} device(s) paired to the old room`,
        );
        revokeAll(stale);
      }
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
      if (!deps.notifyOnRequiresInput()) return;
      pushAgentTransition(push, agent, prevStatus, newStatus);
    },

    relayStatus() {
      const status = connector.status;
      return {
        roomId: roomIdOrNull(),
        connected: status.state === "running",
        error: status.error,
      };
    },

    deviceCount: () => devices.ids().length,

    pushEndpoints: () =>
      devices.pushTargets().map((target) => target.subscription.endpoint),

    setVapidKeys: (keys) => push.importKeys(keys),

    async resetIdentity() {
      // The desktop's `resetRelayAddress` order: revoke and close while the
      // old room still carries each device's 4401 (it reads as "re-pair"),
      // then hang up (the connector holds the old keys) and regenerate.
      revokeAll(devices.ids());
      clearRetry();
      connector.stop();
      identity.reset();
      await Promise.all([identity.flush(), devices.flush()]);
      if (running) connector.start();
    },
  };
}
