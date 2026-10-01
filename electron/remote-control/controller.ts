/**
 * One object the UI talks to for all of ADR-161: the listener, the device
 * store, and the tunnel, plus the single status shape the settings panel and
 * the exposure indicator both render.
 *
 * Two policies live here rather than in the pieces:
 *
 *   - **Nothing starts itself.** Remote control is off at every launch and the
 *     enabled state is deliberately not persisted. A setting that silently
 *     re-opens a listener after an update is exactly the surprise this feature
 *     cannot afford, and re-ticking a box costs the user a second.
 *   - **Disabling means disabled.** Turning remote control off stops the tunnel
 *     too. A live tunnel pointed at a stopped listener still tells the world
 *     the machine is there, and still shows up in the indicator as reachable.
 *
 * The listener and the tunnel manager (the "runtime") are loaded lazily, the
 * first time the user enables remote control or starts a tunnel (ADR-205 §3).
 * Until then the controller answers from what it knows without them: status
 * reports disabled with a stopped tunnel, detection probes PATH directly, and
 * every teardown is a no-op for parts that were never loaded. The device store
 * stays eager — the settings panel lists paired devices with remote control
 * off, and it has no heavy dependencies. The relay (ADR-206) is part of the
 * runtime too: it only runs while remote control is enabled, and its
 * connector and identity pull in `ws` and the Noise crypto.
 *
 * The transitions that change what is reachable — enabling, disabling,
 * starting and stopping the relay, resetting its address — must not
 * interleave into a half-state. A disable drops `wantEnabled` before its
 * first await, and every relay or tunnel start checks it: without that, a
 * Start relay landing while a disable was awaiting the tunnel's exit saw a
 * listener that was still up, and the relay outlived remote control. The
 * relay transitions themselves run one at a time (`serially`).
 */

import { lazy, type Lazy } from "../lib/lazy";
import type {
  Capability,
  PairedVia,
  RemoteDeviceInfo,
  RemoteDeviceStore,
} from "./devices";
import type { RelayConnector, RelayStatus } from "./relay/connector";
import type { RelayIdentityStore } from "./relay/identity";
import { isPushable, pushPayloadFor, type PushManager } from "./push";
import type { PushSubscriptionRecord } from "./devices";
import type { RemoteControlServer, RemoteStatusEvent } from "./server";
import type { TunnelManager } from "./tunnel";
import {
  isCancelled,
  isTailscaleInstalled,
  STOPPED_TUNNEL_STATUS,
  type TailnetInfo,
  type TunnelStatus,
  type WhichFn,
} from "./tunnel-status";

export interface RemoteControlStatus {
  /** Is the listener running? Loopback-only regardless. */
  enabled: boolean;
  port: number | null;
  devices: RemoteDeviceInfo[];
  tunnel: TunnelStatus;
  /** The Manor relay (ADR-206): same shape and policies as the tunnel. */
  relay: RelayStatus;
  /** Whether the tailscale CLI was found, on PATH or in the app bundle. */
  installed: boolean;
  /**
   * Who else is on the tailnet, while a tunnel is running — the address opens
   * only on those devices. Null when not running or Tailscale cannot say.
   */
  tailnet: TailnetInfo | null;
  /** False means pairing cannot store a token — see `RemoteDeviceStore`. */
  encryptionAvailable: boolean;
  /**
   * Live connections of every kind — SSE, listener `/ws`, and relay viewers —
   * so the UI can say whether anyone is watching.
   */
  listeners: number;
  /** Of `listeners`, how many came through the relay (open channels). */
  relayViewers: number;
  /**
   * Something the relay card has to tell the user that is not a connection
   * state — today, that the relay identity could not be read and was
   * replaced, so relay devices were revoked. Null when there is nothing.
   */
  relayNotice: string | null;
}

export interface PairResult {
  device: RemoteDeviceInfo;
  /** Shown once, never stored. */
  rawToken: string;
  /** `https://<tunnel-host><page>#<token>`, or null with no tunnel running. */
  pairingUrl: string | null;
  /**
   * The page this device's link should open — `/app` or `/`, per `pageFor`.
   *
   * Carried on the result rather than recomputed by the caller: the pairing
   * dialog also builds a loopback link for the no-tunnel case, and when the
   * rule lived in two places that link kept pointing at the phone client for
   * a `full` device.
   */
  page: string;
}

/**
 * Which page a paired device's link opens.
 *
 * A `full` device is a browser that wants the whole app, so it lands on the
 * web app at `/app` (ADR-178); the other two tiers get the small phone client
 * at `/`. The fragment is the same either way — the page reads and strips it.
 */
export function pageFor(capability: Capability): string {
  return capability === "full" ? "/app" : "/";
}

/** The heavy half of remote control, loaded on first real use. */
export interface RemoteControlRuntime {
  server: RemoteControlServer;
  tunnel: TunnelManager;
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
  private installed = false;
  private tailnet: TailnetInfo | null = null;
  private tailnetTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(status: RemoteControlStatus) => void>();
  private relayNotice: string | null = null;
  /** The tail of the `serially` queue. */
  private transition: Promise<unknown> = Promise.resolve();

  /** Set once the runtime has loaded; everything sync reads this. */
  private runtime: RemoteControlRuntime | null = null;
  /** Loads the runtime at most once; concurrent callers share the load. */
  private readonly ensureRuntime: Lazy<RemoteControlRuntime>;
  /** The single in-flight listener start, shared by concurrent enables. */
  private starting: Promise<void> | null = null;
  /**
   * The user's latest intent. Every async step re-checks it, so an enable that
   * is overtaken by a disable (or by shutdown) undoes itself rather than
   * leaving a listener up nobody asked for.
   */
  private wantEnabled = false;
  /** Set by `shutdown()`. Nothing starts after this, whatever is in flight. */
  private closed = false;

  constructor(
    loadRuntime: () => Promise<RemoteControlRuntime>,
    private readonly deviceStore: RemoteDeviceStore,
    /** PATH probe for tunnel detection — must not need the runtime. */
    private readonly which: WhichFn,
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
      runtime.tunnel.onStatus((tunnel) => {
        this.watchTailnet(tunnel.state === "running");
        this.emit();
      });
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
   * While the tunnel is up, re-ask who is on the tailnet every few seconds, so
   * the card notices the phone joining without the user doing anything.
   */
  private watchTailnet(running: boolean): void {
    if (!running) {
      if (this.tailnetTimer) clearInterval(this.tailnetTimer);
      this.tailnetTimer = null;
      this.tailnet = null;
      return;
    }
    if (this.tailnetTimer) return;
    void this.refreshTailnet();
    this.tailnetTimer = setInterval(() => void this.refreshTailnet(), 10_000);
    this.tailnetTimer.unref?.();
  }

  private async refreshTailnet(): Promise<void> {
    const tunnel = this.runtime?.tunnel;
    if (!tunnel) return;
    const next = await tunnel.tailnet();
    if (JSON.stringify(next) === JSON.stringify(this.tailnet)) return;
    // The tunnel may have stopped while we were asking.
    if (!this.tailnetTimer) return;
    this.tailnet = next;
    this.emit();
  }

  /**
   * One agent-status transition, fanned out to everything remote control does
   * with one.
   *
   * The app shell calls this beside the desktop notification and the dock
   * badge, and that is all it needs to know: which statuses are worth a push,
   * what a push payload looks like, and that a live SSE client may be
   * listening are all decisions belonging to this module. `notify` is the
   * user's existing "agent needs input" preference, passed in rather than read
   * here — a phone is a second sink on that setting, not a second setting.
   *
   * Cheap when nothing is running: with the runtime not loaded there is no
   * listener to publish to, the server drops the event with no SSE clients,
   * and push returns early with no subscriptions.
   */
  onAgentStatus(
    agent: { id: string; name: string | null; projectName: string | null },
    previousStatus: string | null | undefined,
    status: string,
    { notify }: { notify: boolean },
  ): void {
    if (this.runtime) {
      const event: RemoteStatusEvent = {
        agentId: agent.id,
        name: agent.name,
        projectName: agent.projectName,
        status,
        previousStatus: previousStatus ?? null,
      };
      this.runtime.server.publishStatus(event);
    }

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
      installed: this.installed,
      tailnet: this.tailnet,
      encryptionAvailable: this.encryptionAvailable(),
      relayNotice: this.relayNotice,
    };
  }

  /**
   * Re-probe PATH. Cheap, and the user may have installed a tool since launch.
   * Does not load the runtime: opening the settings panel must not.
   */
  async refreshDetection(): Promise<RemoteControlStatus> {
    this.installed = await isTailscaleInstalled(this.which);
    this.emit();
    return this.status();
  }

  async setEnabled(enabled: boolean): Promise<RemoteControlStatus> {
    if (enabled) {
      if (this.closed) return this.status();
      this.wantEnabled = true;
      // Loop rather than a single await: a start overtaken by a disable stops
      // its own listener, and if the intent flipped back to "on" meanwhile we
      // start again rather than report a listener that is not there.
      while (
        !this.closed &&
        this.wantEnabled &&
        !this.runtime?.server.running
      ) {
        if (!this.starting) {
          this.starting = this.startListener().finally(() => {
            this.starting = null;
          });
        }
        await this.starting;
      }
      await this.refreshDetection();
    } else {
      this.wantEnabled = false;
      // Never loads: waits for a load already in flight (so what it starts can
      // be stopped), and is a no-op when the runtime was never asked for.
      const runtime = await this.loadedRuntime();
      if (runtime) {
        // Order matters: drop the exposure before the thing being exposed, so
        // there is no window where a tunnel points at a closing listener.
        runtime.relay?.stop();
        await runtime.tunnel.stop();
        await runtime.server.stop();
      }
    }
    this.emit();
    return this.status();
  }

  pair(
    label: string,
    capability: Capability,
    via: PairedVia = "tailscale",
  ): PairResult {
    if (via === "relay") return this.pairViaRelay(label, capability);
    const { device, rawToken } = this.deviceStore.pair(label, capability, via);
    const url = this.runtime?.tunnel.status.url ?? null;
    this.emit();
    const page = pageFor(capability);
    return {
      device,
      rawToken,
      page,
      pairingUrl: url ? `${url}${page}#${rawToken}` : null,
    };
  }

  /**
   * A relay device reaches the whole bridge or nothing: the relay carries only
   * the `/ws` pipe, which the narrower tiers' HTTP allowlists never use.
   *
   * Needs the runtime (the identity lives there), which is loaded whenever
   * remote control is on — and the pairing dialog only shows then.
   */
  private pairViaRelay(label: string, capability: Capability): PairResult {
    if (capability !== "full") {
      throw new Error("Devices paired through the relay must be Everything.");
    }
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
    const { device, rawToken } = this.deviceStore.pair(
      label,
      capability,
      "relay",
      roomId,
    );
    this.emit();
    return {
      device,
      rawToken,
      page: pageFor(capability),
      pairingUrl: `${origin}/app/${this.appVersion}/#relay=${roomId}.${x25519Pub}&t=${rawToken}`,
    };
  }

  revoke(id: string): RemoteControlStatus {
    this.deviceStore.revoke(id);
    // Revoke means now: the store only stops new hellos. With the runtime
    // never loaded there is no connection to close.
    this.runtime?.server.closeDevice(id);
    this.emit();
    return this.status();
  }

  /**
   * Start the tunnel. Tailscale is the only kind there is. Detection is
   * re-checked here rather than trusting the last `refreshDetection` — the
   * user may only just have installed it.
   */
  async startTunnel(): Promise<RemoteControlStatus> {
    const runtime = this.closed ? null : await this.ensureRuntime();
    // `wantEnabled` is false while a disable is taking things down, before
    // the listener has actually stopped.
    if (
      !runtime ||
      this.closed ||
      !this.wantEnabled ||
      !runtime.server.running
    ) {
      throw new Error("Enable remote control before starting a tunnel.");
    }
    const { server, tunnel } = runtime;
    this.installed = await tunnel.detect();
    if (!this.installed) {
      throw new Error(
        "Tailscale is not installed. Install it from Settings → Remote " +
          "control, sign in, and try again.",
      );
    }
    // Remote control may have been turned off (or the app quit) while PATH
    // was probed; spawning now would expose nothing, or outlive the app.
    if (this.closed || !this.wantEnabled || !server.running) {
      throw new Error("Enable remote control before starting a tunnel.");
    }
    try {
      await tunnel.start(server.serverPort);
    } catch (err) {
      // A `stopTunnel()` while starting (Cancel) is not a failure.
      if (!isCancelled(err)) throw err;
    }
    if (this.closed || !this.wantEnabled || !server.running) {
      // Torn down while the tunnel came up. It must not survive that.
      await tunnel.stop();
      throw new Error("Remote control was turned off while the tunnel started.");
    }
    this.emit();
    return this.status();
  }

  async stopTunnel(): Promise<RemoteControlStatus> {
    const runtime = await this.loadedRuntime();
    if (runtime) await runtime.tunnel.stop();
    this.emit();
    return this.status();
  }

  /**
   * Start the relay. Like the tunnel, only while remote control is on — so
   * the runtime is loaded, and this never loads it.
   */
  startRelay(): Promise<RemoteControlStatus> {
    return this.serially(() => {
      const runtime = this.runtime;
      if (
        !runtime ||
        this.closed ||
        !this.wantEnabled ||
        !runtime.server.running
      ) {
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
   * so every device paired through it is revoked.
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
   * there) — a reset with remote control off still kills every relay link.
   */
  resetRelayAddress(): Promise<RemoteControlStatus> {
    return this.serially(async () => {
      const runtime = this.closed ? null : await this.ensureRuntime();
      const relay = runtime?.relay;
      const identity = runtime?.relayIdentity;
      if (!runtime || !relay || !identity) {
        throw new Error("The relay is not available.");
      }
      const ids = this.deviceStore.idsVia("relay");
      for (const id of ids) {
        this.deviceStore.revoke(id);
        runtime.server.closeDevice(id);
      }
      relay.stop();
      identity.reset();
      this.relayNotice = null;
      this.emit();
      return this.status();
    });
  }

  /**
   * Relay devices paired to a room this desktop no longer owns hold dead
   * links. The identity store replaces an identity it cannot read with a new
   * one (a new room) without a word, so this is where the user finds out:
   * those devices are revoked, and the relay card says why.
   */
  private revokeStaleRelayDevices(roomId: string): void {
    const stale = this.deviceStore.idsInOtherRelayRooms(roomId);
    if (stale.length === 0) return;
    for (const id of stale) {
      this.deviceStore.revoke(id);
      this.runtime?.server.closeDevice(id);
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
   * Last-resort teardown for the paths that skip `before-quit` — `app.exit()`
   * and fatal errors. Synchronous because `process.on("exit")` is: a tunnel
   * surviving the app is this feature's worst failure mode, so it gets the
   * ungraceful kill rather than a promise nobody will await. A runtime still
   * loading has spawned nothing yet, so there is nothing to kill.
   */
  killTunnelNow(): void {
    this.runtime?.tunnel.killNow();
  }

  /**
   * Quit path: the tunnel must never outlive the app. Marks the controller
   * closed first, so anything in flight (a load, a listener start, a tunnel
   * start) sees it at its next step and backs out, then waits for a pending
   * load and stops whatever it produced.
   */
  async shutdown(): Promise<void> {
    this.closed = true;
    this.wantEnabled = false;
    this.watchTailnet(false);
    const runtime = await this.loadedRuntime();
    if (!runtime) return;
    runtime.relay?.stop();
    await runtime.tunnel.stop();
    await runtime.server.stop();
    // A listener start that was mid-`listen()` stops itself on seeing
    // `closed`; wait for that so shutdown resolves with nothing running.
    await this.starting?.catch(() => {});
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

  private async startListener(): Promise<void> {
    const runtime = await this.ensureRuntime();
    if (this.closed || !this.wantEnabled) return;
    await runtime.server.start();
    if (this.closed || !this.wantEnabled) {
      // Overtaken by a disable or by shutdown while `listen()` was pending.
      // Their `stop()` found nothing to close yet, so close it here.
      await runtime.server.stop();
    }
  }

  /** The runtime's part of `status()`; disabled and stopped until it loads. */
  private runtimeStatus(): Pick<
    RemoteControlStatus,
    "enabled" | "port" | "tunnel" | "relay" | "listeners" | "relayViewers"
  > {
    if (!this.runtime) {
      return {
        enabled: false,
        port: null,
        tunnel: { ...STOPPED_TUNNEL_STATUS },
        relay: { ...STOPPED_RELAY_STATUS },
        listeners: 0,
        relayViewers: 0,
      };
    }
    const { server, tunnel, relay } = this.runtime;
    return {
      enabled: server.running,
      port: server.running ? server.serverPort : null,
      tunnel: tunnel.status,
      relay: relay?.status ?? { ...STOPPED_RELAY_STATUS },
      listeners: server.listenerCount,
      relayViewers: relay?.channelCount ?? 0,
    };
  }

  private emit(): void {
    const status = this.status();
    for (const listener of [...this.listeners]) listener(status);
  }
}
