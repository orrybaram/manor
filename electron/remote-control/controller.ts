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
 * off, and it has no heavy dependencies.
 */

import { lazy, type Lazy } from "../lib/lazy";
import type {
  Capability,
  RemoteDeviceInfo,
  RemoteDeviceStore,
} from "./devices";
import { isPushable, pushPayloadFor, type PushManager } from "./push";
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
  /** Whether the tailscale CLI was found, on PATH or in the app bundle. */
  installed: boolean;
  /**
   * Who else is on the tailnet, while a tunnel is running — the address opens
   * only on those devices. Null when not running or Tailscale cannot say.
   */
  tailnet: TailnetInfo | null;
  /** False means pairing cannot store a token — see `RemoteDeviceStore`. */
  encryptionAvailable: boolean;
  /** Live SSE connections, so the UI can say whether anyone is watching. */
  listeners: number;
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
}

export class RemoteControlController {
  private installed = false;
  private tailnet: TailnetInfo | null = null;
  private tailnetTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(status: RemoteControlStatus) => void>();

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
  ) {
    this.ensureRuntime = lazy(async () => {
      const runtime = await loadRuntime();
      this.runtime = runtime;
      runtime.tunnel.onStatus((tunnel) => {
        this.watchTailnet(tunnel.state === "running");
        this.emit();
      });
      return runtime;
    });
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
        await runtime.tunnel.stop();
        await runtime.server.stop();
      }
    }
    this.emit();
    return this.status();
  }

  pair(label: string, capability: Capability): PairResult {
    const { device, rawToken } = this.deviceStore.pair(label, capability);
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

  revoke(id: string): RemoteControlStatus {
    this.deviceStore.revoke(id);
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
    if (!runtime || this.closed || !runtime.server.running) {
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
    if (this.closed || !server.running) {
      throw new Error("Enable remote control before starting a tunnel.");
    }
    try {
      await tunnel.start(server.serverPort);
    } catch (err) {
      // A `stopTunnel()` while starting (Cancel) is not a failure.
      if (!isCancelled(err)) throw err;
    }
    if (this.closed || !server.running) {
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
    "enabled" | "port" | "tunnel" | "listeners"
  > {
    if (!this.runtime) {
      return {
        enabled: false,
        port: null,
        tunnel: { ...STOPPED_TUNNEL_STATUS },
        listeners: 0,
      };
    }
    const { server, tunnel } = this.runtime;
    return {
      enabled: server.running,
      port: server.running ? server.serverPort : null,
      tunnel: tunnel.status,
      listeners: server.listenerCount,
    };
  }

  private emit(): void {
    const status = this.status();
    for (const listener of [...this.listeners]) listener(status);
  }
}
