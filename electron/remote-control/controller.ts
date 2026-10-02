/**
 * One object the UI talks to for all of remote control: the device store,
 * the relay's hello gate and the relay itself (ADR-206 — since ADR-207 the
 * only way in), plus the single status shape the settings panel and the
 * exposure indicator both render.
 *
 * Two policies live here rather than in the pieces:
 *
 *   - **Nothing starts itself.** Remote control is off at every launch and the
 *     enabled state is deliberately not persisted. A setting that silently
 *     makes the machine reachable again after an update is exactly the
 *     surprise this feature cannot afford, and re-ticking a box costs the
 *     user a second.
 *   - **Disabling means disabled.** Turning remote control off stops the relay
 *     too, and closes every connection the gate let in.
 *
 * Enabling opens nothing: it loads the runtime (ADR-207 D3) — the gate, the
 * bridge transport, the connector and the relay identity, which pull in `ws`
 * and the Noise crypto (ADR-205 §3) — and flips the controller's own
 * `enabled` flag. Starting the relay is a separate, confirmed action. Until
 * the runtime loads the controller answers from what it knows without it:
 * status reports disabled with a stopped relay, and every teardown is a no-op
 * for parts that were never loaded. The device store stays eager — the
 * settings panel lists paired devices with remote control off, and it has no
 * heavy dependencies.
 *
 * The transitions that change what is reachable — enabling, disabling,
 * starting and stopping the relay, resetting its address — must not
 * interleave into a half-state. A disable drops `wantEnabled` before its
 * first await, and every relay start checks it, so a Start relay landing
 * while a disable is in flight cannot outlive it. The relay transitions
 * themselves run one at a time (`serially`).
 */

import { lazy, type Lazy } from "../lib/lazy";
import type { RemoteDeviceInfo, RemoteDeviceStore } from "./devices";
import type { RelayConnector, RelayStatus } from "./relay/connector";
import type { RelayIdentityStore } from "./relay/identity";
import { isPushable, pushPayloadFor, type PushManager } from "./push";
import type { PushSubscriptionRecord } from "./devices";
import type { RelayGate } from "./relay-gate";

export interface RemoteControlStatus {
  /** Is remote control on? Nothing listens either way; see the header. */
  enabled: boolean;
  devices: RemoteDeviceInfo[];
  /** The Manor relay (ADR-206). */
  relay: RelayStatus;
  /**
   * The relay's web origin, which pairing links point at — or null when
   * nothing can be paired: the runtime has not loaded, the relay is
   * unavailable, or its configured address is not a valid URL.
   */
  relayOrigin: string | null;
  /** False means pairing cannot store a token — see `RemoteDeviceStore`. */
  encryptionAvailable: boolean;
  /**
   * Open relay channels — every live connection there is, so the UI can say
   * whether anyone is watching.
   */
  relayViewers: number;
  /**
   * Something the relay card has to tell the user that is not a connection
   * state — today, that the relay identity could not be read and was
   * replaced, so paired devices were revoked. Null when there is nothing.
   */
  relayNotice: string | null;
}

export interface PairResult {
  device: RemoteDeviceInfo;
  /** Shown once, never stored. */
  rawToken: string;
  /** The relay link (`https://<relay>/app/<version>/#relay=…`). */
  pairingUrl: string;
}

/** The heavy half of remote control, loaded on first real use. */
export interface RemoteControlRuntime {
  /** The relay's hello gate, and the bridge transport behind it. */
  gate: RelayGate;
  /** The relay connector (ADR-206). Absent: the relay is unavailable. */
  relay?: RelayConnector | null;
  /** The relay's keys, the room and the Noise static. Absent with `relay`. */
  relayIdentity?: RelayIdentityStore | null;
}

const STOPPED_RELAY_STATUS: Readonly<RelayStatus> = Object.freeze({
  state: "stopped",
  url: null,
  error: null,
});

export class RemoteControlController {
  private listeners = new Set<(status: RemoteControlStatus) => void>();
  private relayNotice: string | null = null;
  /** The tail of the `serially` queue. */
  private transition: Promise<unknown> = Promise.resolve();

  /** Set once the runtime has loaded; everything sync reads this. */
  private runtime: RemoteControlRuntime | null = null;
  /** Loads the runtime at most once; concurrent callers share the load. */
  private readonly ensureRuntime: Lazy<RemoteControlRuntime>;
  /** Is remote control on? Only ever true with the runtime loaded. */
  private enabled = false;
  /**
   * The user's latest intent. Every async step re-checks it, so an enable that
   * is overtaken by a disable (or by shutdown) undoes itself rather than
   * turning on something nobody asked for.
   */
  private wantEnabled = false;
  /** Set by `shutdown()`. Nothing starts after this, whatever is in flight. */
  private closed = false;

  constructor(
    loadRuntime: () => Promise<RemoteControlRuntime>,
    private readonly deviceStore: RemoteDeviceStore,
    private readonly encryptionAvailable: () => boolean,
    /** Null disables push; everything else still works. */
    private readonly push: PushManager | null = null,
    /** The version segment of relay pairing links (`/app/<version>/`). */
    private readonly appVersion: string = "0.0.0",
  ) {
    this.ensureRuntime = lazy(async () => {
      const runtime = await loadRuntime();
      this.runtime = runtime;
      runtime.relay?.onStatus(() => this.emit());
      return runtime;
    });
  }

  /**
   * The VAPID application server key, or null when push is unavailable.
   * Async because `web-push` (and so key generation) loads lazily (ADR-205).
   */
  async vapidPublicKey(): Promise<string | null> {
    return (await this.push?.publicKey()) ?? null;
  }

  /** Store a device's push subscription. False: no push, or no such device. */
  subscribePush(
    deviceId: string,
    subscription: PushSubscriptionRecord,
  ): boolean {
    return this.push?.subscribe(deviceId, subscription) ?? false;
  }

  /**
   * One agent-status transition, as a push to paired devices.
   *
   * The app shell calls this beside the desktop notification and the dock
   * badge, and that is all it needs to know: which statuses are worth a push
   * and what a push payload looks like are decisions belonging to this
   * module. A browser on the bridge hears the status itself, over
   * `agents.onStatus`. `notify` is the user's existing "agent needs input"
   * preference, passed in rather than read here — a phone is a second sink
   * on that setting, not a second setting.
   *
   * Cheap when nothing is subscribed: push returns early with no
   * subscriptions, and nothing here loads the runtime.
   */
  onAgentStatus(
    agent: { id: string; name: string | null; projectName: string | null },
    previousStatus: string | null | undefined,
    status: string,
    { notify }: { notify: boolean },
  ): void {
    if (!this.push || !notify) return;
    if (!isPushable(status) || status === previousStatus) return;
    void this.push.notify(pushPayloadFor(status, agent));
  }

  onChange(listener: (status: RemoteControlStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(): RemoteControlStatus {
    return {
      ...this.runtimeStatus(),
      devices: this.deviceStore.list(),
      encryptionAvailable: this.encryptionAvailable(),
      relayNotice: this.relayNotice,
    };
  }

  async setEnabled(enabled: boolean): Promise<RemoteControlStatus> {
    if (enabled) {
      if (this.closed) return this.status();
      this.wantEnabled = true;
      const runtime = await this.ensureRuntime();
      // Overtaken by a disable or by shutdown while the runtime loaded: their
      // turn-off already ran (or found nothing to turn off), so stay off.
      if (!this.closed && this.wantEnabled && !this.enabled) {
        runtime.gate.open();
        this.enabled = true;
      }
    } else {
      this.wantEnabled = false;
      // Never loads: waits for a load already in flight (so what it brings up
      // can be turned off), and is a no-op when the runtime was never asked
      // for.
      const runtime = await this.loadedRuntime();
      if (runtime) this.turnOff(runtime);
    }
    this.emit();
    return this.status();
  }

  /**
   * Pair a device through the relay — the only road (ADR-207 D4). Every
   * device reaches the whole bridge.
   *
   * Needs the runtime (the identity lives there), which is loaded whenever
   * remote control is on — and the pairing form only shows then.
   */
  pair(label: string): PairResult {
    const relay = this.runtime?.relay;
    const identity = this.runtime?.relayIdentity;
    if (!this.runtime) {
      throw new Error("Enable remote control before pairing through the relay.");
    }
    if (!relay || !identity) {
      throw new Error("The relay is not available.");
    }
    const origin = relay.origin;
    if (!origin) throw new Error("The relay address is not configured.");
    const { roomId, x25519Pub } = identity.describe();
    this.revokeStaleRelayDevices(roomId);
    const { device, rawToken } = this.deviceStore.pair(label, roomId);
    this.emit();
    return {
      device,
      rawToken,
      pairingUrl: `${origin}/app/${this.appVersion}/#relay=${roomId}.${x25519Pub}&t=${rawToken}`,
    };
  }

  revoke(id: string): RemoteControlStatus {
    this.deviceStore.revoke(id);
    // Revoke means now: the store only stops new hellos. With the runtime
    // never loaded there is no connection to close.
    this.runtime?.gate.closeDevice(id);
    this.emit();
    return this.status();
  }

  /**
   * Start the relay. Only while remote control is on — so the runtime is
   * loaded, and this never loads it.
   */
  startRelay(): Promise<RemoteControlStatus> {
    return this.serially(() => {
      const runtime = this.runtime;
      if (!runtime || this.closed || !this.wantEnabled || !this.enabled) {
        throw new Error("Enable remote control before starting the relay.");
      }
      const { relay, relayIdentity } = runtime;
      if (!relay || !relayIdentity) {
        throw new Error("The relay is not available.");
      }
      relay.start();
      // `start` has loaded the identity (or replaced an unreadable one), so
      // this is the first moment a changed room can be noticed.
      if (relay.status.state !== "failed") {
        this.revokeStaleRelayDevices(relayIdentity.describe().roomId);
      }
      this.emit();
      return this.status();
    });
  }

  stopRelay(): Promise<RemoteControlStatus> {
    return this.serially(() => {
      this.runtime?.relay?.stop();
      this.emit();
      return this.status();
    });
  }

  /**
   * New room, new keys: every link ever shared for the old address is dead,
   * so every device is revoked.
   *
   * The order is what makes each relay browser hear *why*. Revoking closes a
   * device's channels with 4401, which travels to the browser through the
   * live relay and reads there as "re-pair". Stopping the relay first would
   * take the host socket away underneath them, and the room would answer
   * 4404 — "this machine is not reachable" — a retry loop rather than a
   * prompt. So: revoke and close, then stop (the connector holds the old
   * keys) and reset.
   *
   * An explicit user action, so it may load the runtime (the identity lives
   * there) — a reset with remote control off still kills every link.
   */
  resetRelayAddress(): Promise<RemoteControlStatus> {
    return this.serially(async () => {
      const runtime = this.closed ? null : await this.ensureRuntime();
      const relay = runtime?.relay;
      const identity = runtime?.relayIdentity;
      if (!runtime || !relay || !identity) {
        throw new Error("The relay is not available.");
      }
      for (const id of this.deviceStore.ids()) {
        this.deviceStore.revoke(id);
        runtime.gate.closeDevice(id);
      }
      relay.stop();
      identity.reset();
      this.relayNotice = null;
      this.emit();
      return this.status();
    });
  }

  /**
   * Devices paired to a room this desktop no longer owns hold dead
   * links. The identity store replaces an identity it cannot read with a new
   * one (a new room) without a word, so this is where the user finds out:
   * those devices are revoked, and the relay card says why.
   */
  private revokeStaleRelayDevices(roomId: string): void {
    const stale = this.deviceStore.idsInOtherRelayRooms(roomId);
    if (stale.length === 0) return;
    for (const id of stale) {
      this.deviceStore.revoke(id);
      this.runtime?.gate.closeDevice(id);
    }
    const n = stale.length;
    this.relayNotice =
      "This machine's relay identity couldn't be read, so it has a new " +
      `relay address. ${n} device${n === 1 ? "" : "s"} paired through the ` +
      `relay ${n === 1 ? "was" : "were"} revoked; pair ${n === 1 ? "it" : "them"} again.`;
  }

  /**
   * Run the relay transitions one at a time. A failure rejects that caller
   * only; the queue carries on.
   */
  private serially<T>(step: () => T | Promise<T>): Promise<T> {
    const run = this.transition.then(step);
    this.transition = run.catch(() => undefined);
    return run;
  }

  /**
   * Quit path: nothing reachable may outlive the app. Marks the controller
   * closed first, so a load in flight sees it and backs out, then waits for
   * that load and turns off whatever it produced.
   */
  async shutdown(): Promise<void> {
    this.closed = true;
    this.wantEnabled = false;
    const runtime = await this.loadedRuntime();
    if (runtime) this.turnOff(runtime);
  }

  /**
   * Order matters: stop the relay before closing what the gate let in, so
   * no new channel arrives while the old ones are being closed.
   */
  private turnOff(runtime: RemoteControlRuntime): void {
    runtime.relay?.stop();
    runtime.gate.close();
    this.enabled = false;
  }

  /** The runtime if loaded or already loading. Never starts a load. */
  private async loadedRuntime(): Promise<RemoteControlRuntime | null> {
    if (this.runtime) return this.runtime;
    const started = this.ensureRuntime.started();
    if (!started) return null;
    try {
      return await started;
    } catch {
      return null;
    }
  }

  /** The runtime's part of `status()`; disabled and stopped until it loads. */
  private runtimeStatus(): Pick<
    RemoteControlStatus,
    "enabled" | "relay" | "relayOrigin" | "relayViewers"
  > {
    const relay = this.runtime?.relay;
    return {
      enabled: this.enabled,
      relay: relay?.status ?? { ...STOPPED_RELAY_STATUS },
      relayOrigin:
        relay && this.runtime?.relayIdentity ? relay.origin : null,
      relayViewers: relay?.channelCount ?? 0,
    };
  }

  private emit(): void {
    const status = this.status();
    for (const listener of [...this.listeners]) listener(status);
  }
}
