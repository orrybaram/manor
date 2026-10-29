/**
 * One object the UI talks to for all of remote control: the device store,
 * the relay's hello gate and the relay itself (the only way in), plus the
 * single status shape the settings panel and the exposure indicator both
 * render.
 *
 * Two policies live here rather than in the pieces:
 *
 *   - **Nothing starts itself unless asked to.** Remote control is off at
 *     every launch and the enabled state is deliberately not persisted. A
 *     setting that silently makes the machine reachable again after an update
 *     is exactly the surprise this feature cannot afford. The one way back on
 *     is the user's own "Turn on when Manor opens" (`startOnLaunch`): a
 *     standing instruction they set, from this computer only, and that the
 *     settings panel shows beside the switch it flips.
 *   - **Disabling means disabled.** Turning remote control off stops the relay
 *     too, and closes every connection the gate let in.
 *
 * Enabling opens nothing: it loads the runtime — the gate, the
 * bridge transport, the connector and the relay identity, which pull in `ws`
 * and the Noise crypto — and flips the controller's own
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
 *
 * Who is paired — pair, revoke, reset, stale-room revokes — is the room's
 * business (`RelayRoom`, shared with the host server's relay); the controller
 * decides when those may run and what the user is told.
 */

import { lazy, type Lazy } from "../lib/lazy";
import { serialQueue, type Serially } from "../lib/serial";
import type { RemoteDeviceInfo, RemoteDeviceStore } from "./devices";
import type { RelayConnector, RelayStatus } from "./relay/connector";
import type { RelayIdentityStore } from "./relay/identity";
import { pushAgentTransition, pushAutomationRun, type PushManager } from "./push";
import { relayAppUrl } from "./relay/url";
import type { PushSubscriptionRecord } from "./devices";
import type { RelayGate } from "./relay-gate";
import { RelayRoom, type PairResult } from "./relay-room";

export interface RemoteControlStatus {
  /** Is remote control on? Nothing listens either way; see the header. */
  enabled: boolean;
  devices: RemoteDeviceInfo[];
  /** The Manor relay. */
  relay: RelayStatus;
  /**
   * The relay's web origin, which pairing links point at — or null when
   * nothing can be paired: the runtime has not loaded, the relay is
   * unavailable, or its configured address is not a valid URL.
   */
  relayOrigin: string | null;
  /**
   * The web app on the relay, with no credentials in it
   * (`https://<relay>/app/<version>/`). A browser that was already paired
   * keeps its pairing in its own storage, so this opens it paired; it is safe
   * to show as a QR code whenever the relay is running. Null exactly when
   * `relayOrigin` is.
   */
  relayAppUrl: string | null;
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
  /** Turn remote control on, relay and all, every time Manor opens. */
  startOnLaunch: boolean;
}

/** The heavy half of remote control, loaded on first real use. */
export interface RemoteControlRuntime {
  /** The relay's hello gate, and the bridge transport behind it. */
  gate: RelayGate;
  /** The relay connector. Absent: the relay is unavailable. */
  relay?: RelayConnector | null;
  /** The relay's keys, the room and the Noise static. Absent with `relay`. */
  relayIdentity?: RelayIdentityStore | null;
}

export interface RemoteControlControllerOptions {
  /** Loads the heavy half, on first real use. */
  loadRuntime: () => Promise<RemoteControlRuntime>;
  /** Eager: the settings panel lists devices with remote control off. */
  devices: RemoteDeviceStore;
  /** Null or absent disables push; everything else still works. */
  push?: PushManager | null;
  /** The version segment of relay pairing links (`/app/<version>/`). */
  appVersion?: string;
  /**
   * The push endpoints a host's server already sends to (cached), so those
   * phones are not told twice. Empty for a host not cached.
   */
  hostPushEndpoints?: (hostId: string) => ReadonlySet<string>;
  /**
   * Where "Turn on when Manor opens" is kept. Absent: never set, and
   * `setStartOnLaunch` refuses.
   */
  startOnLaunch?: { get(): boolean; set(on: boolean): void };
}

const UNREADABLE_DEVICES_NOTICE =
  "Paired devices could not be read, so none are listed and pairing is " +
  "unavailable. Restart Manor; if this persists, check the keychain.";

const EMPTY_SET: ReadonlySet<string> = new Set();

const STOPPED_RELAY_STATUS: Readonly<RelayStatus> = Object.freeze({
  state: "stopped",
  url: null,
  error: null,
});

export class RemoteControlController {
  private listeners = new Set<(status: RemoteControlStatus) => void>();
  private relayNotice: string | null = null;
  /** Runs the relay transitions one at a time; see the header. */
  private readonly serially: Serially = serialQueue();
  private readonly deviceStore: RemoteDeviceStore;
  private readonly push: PushManager | null;
  private readonly appVersion: string;
  private readonly hostPushEndpoints: (hostId: string) => ReadonlySet<string>;
  private readonly room: RelayRoom;
  private readonly startOnLaunchSetting: RemoteControlControllerOptions["startOnLaunch"];

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

  constructor({
    loadRuntime,
    devices,
    push = null,
    appVersion = "0.0.0",
    hostPushEndpoints = () => EMPTY_SET,
    startOnLaunch,
  }: RemoteControlControllerOptions) {
    this.startOnLaunchSetting = startOnLaunch;
    this.deviceStore = devices;
    this.push = push;
    this.appVersion = appVersion;
    this.hostPushEndpoints = hostPushEndpoints;
    this.room = new RelayRoom({
      devices,
      appVersion,
      // Until the runtime loads there is no connection to close.
      gate: () => this.runtime?.gate ?? null,
      relay: () => {
        const connector = this.runtime?.relay;
        const identity = this.runtime?.relayIdentity;
        return connector && identity ? { connector, identity } : null;
      },
      // The identity store replaced an identity it could not read with a new
      // one (a new room) without a word, so this is where the user finds out.
      onStaleRevoked: (n) => {
        this.relayNotice =
          "This machine's relay identity couldn't be read, so it has a new " +
          `relay address. ${n} device${n === 1 ? "" : "s"} paired through the ` +
          `relay ${n === 1 ? "was" : "were"} revoked; pair ${n === 1 ? "it" : "them"} again.`;
      },
    });
    this.ensureRuntime = lazy(async () => {
      const runtime = await loadRuntime();
      this.runtime = runtime;
      runtime.relay?.onStatus(() => this.emit());
      runtime.gate.onDeviceSeen(() => this.emit());
      return runtime;
    });
  }

  /**
   * The VAPID application server key, or null when push is unavailable.
   * Async because `web-push` (and so key generation) loads lazily.
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
    agent: {
      id: string;
      name: string | null;
      projectName: string | null;
      /** Absent or `local`: the desktop is the only one pushing for it. */
      hostId?: string;
      /** The automation whose run started it, which titles the push. */
      automationName?: string | null;
    },
    previousStatus: string | null | undefined,
    status: string,
    { notify }: { notify: boolean },
  ): void {
    if (!this.push || !notify) return;
    // An agent on a remote host whose server already pushes to some of these
    // phones is told about by that server, not twice.
    pushAgentTransition(this.push, agent, previousStatus, status, {
      skipEndpoints: agent.hostId
        ? this.hostPushEndpoints(agent.hostId)
        : undefined,
    });
  }

  /**
   * A run of one of this desktop's own automations, as a push when it
   * failed to start (`pushAutomationRun`). `notify` is the same preference
   * an agent's push follows. A remote host's runs are its server's to push.
   */
  onAutomationRun(
    automation: { id: string; name: string },
    run: { outcome: string; detail?: string },
    { notify }: { notify: boolean },
  ): void {
    if (!this.push || !notify) return;
    pushAutomationRun(this.push, automation, run);
  }

  onChange(listener: (status: RemoteControlStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(): RemoteControlStatus {
    // A store that could not be read (init failed) refuses `list()`; report
    // that rather than throwing out of every status read.
    const ready = this.deviceStore.ready;
    return {
      ...this.runtimeStatus(),
      devices: ready ? this.deviceStore.list() : [],
      encryptionAvailable: this.deviceStore.encryptionAvailable(),
      relayNotice: ready ? this.relayNotice : UNREADABLE_DEVICES_NOTICE,
      startOnLaunch: this.startOnLaunchSetting?.get() ?? false,
    };
  }

  /** Keep, or drop, the standing instruction to turn on at launch. */
  setStartOnLaunch(on: boolean): RemoteControlStatus {
    if (!this.startOnLaunchSetting) {
      throw new Error("Starting remote control on launch is not available.");
    }
    this.startOnLaunchSetting.set(on);
    this.emit();
    return this.status();
  }

  /**
   * Launch: what the switch does — enable, then start the relay — when the
   * user asked for it on every launch. Nothing when they did not, or when
   * device tokens cannot be stored safely (the switch is locked then too).
   * A relay that cannot start says so in the status, as it would from the
   * switch.
   */
  async startIfAsked(): Promise<void> {
    if (!this.startOnLaunchSetting?.get()) return;
    if (!this.deviceStore.encryptionAvailable()) return;
    const status = await this.setEnabled(true);
    if (!status.enabled) return;
    await this.startRelay();
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
   * Pair a device through the relay — the only road. Every
   * device reaches the whole bridge.
   *
   * Needs the runtime (the identity lives there), which is loaded whenever
   * remote control is on — and the pairing form only shows then. Resolves once
   * the device is on disk. The link carries a single-use ticket unless
   * `direct` asks for the token itself.
   */
  async pair(
    label: string,
    options?: { direct?: boolean },
  ): Promise<PairResult> {
    if (!this.runtime) {
      throw new Error("Enable remote control before pairing through the relay.");
    }
    const result = await this.room.pair(label, options);
    this.emit();
    return result;
  }

  /**
   * A new link for a device that has not connected yet; the old one is dead.
   * Resolves once the new ticket is on disk.
   */
  async reissue(id: string): Promise<PairResult> {
    if (!this.runtime) {
      throw new Error("Enable remote control before pairing through the relay.");
    }
    const result = await this.room.reissue(id);
    this.emit();
    return result;
  }

  /**
   * Resolves once the revoke is on disk, and rejects when it could not be
   * saved: the device is refused and disconnected either way, but would be
   * back after a restart, and the user has to hear that.
   */
  async revoke(id: string): Promise<RemoteControlStatus> {
    try {
      await this.room.revoke(id);
    } finally {
      // Refused and disconnected whether or not the write landed.
      this.emit();
    }
    return this.status();
  }

  /**
   * Start the relay. Only while remote control is on — so the runtime is
   * loaded, and this never loads it.
   */
  startRelay(): Promise<RemoteControlStatus> {
    return this.serially(async () => {
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
        await this.room.revokeStale(relayIdentity.describe().roomId);
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
   * New room, new keys, every device revoked (`RelayRoom.reset`, which
   * explains the order). The relay is left stopped.
   *
   * An explicit user action, so it may load the runtime (the identity lives
   * there) — a reset with remote control off still kills every link.
   */
  resetRelayAddress(): Promise<RemoteControlStatus> {
    return this.serially(async () => {
      if (this.closed) throw new Error("The relay is not available.");
      await this.ensureRuntime();
      await this.room.reset();
      this.relayNotice = null;
      this.emit();
      return this.status();
    });
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
    "enabled" | "relay" | "relayOrigin" | "relayAppUrl" | "relayViewers"
  > {
    const relay = this.runtime?.relay;
    const relayOrigin =
      relay && this.runtime?.relayIdentity ? relay.origin : null;
    return {
      enabled: this.enabled,
      relay: relay?.status ?? { ...STOPPED_RELAY_STATUS },
      relayOrigin,
      relayAppUrl: relayOrigin
        ? relayAppUrl(relayOrigin, this.appVersion)
        : null,
      relayViewers: relay?.channelCount ?? 0,
    };
  }

  private emit(): void {
    const status = this.status();
    for (const listener of [...this.listeners]) listener(status);
  }
}
