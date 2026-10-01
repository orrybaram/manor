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
  detectTunnelTools,
  STOPPED_TUNNEL_STATUS,
  type TunnelKind,
  type TunnelStatus,
  type WhichFn,
} from "./tunnel-status";

export interface RemoteControlStatus {
  /** Is the listener running? Loopback-only regardless. */
  enabled: boolean;
  port: number | null;
  devices: RemoteDeviceInfo[];
  tunnel: TunnelStatus;
  /** Which tunnel binaries are on PATH. Manor installs neither. */
  detected: Record<TunnelKind, boolean>;
  /** False means pairing cannot store a token — see `RemoteDeviceStore`. */
  encryptionAvailable: boolean;
  /** Live SSE connections, so the UI can say whether anyone is watching. */
  listeners: number;
}

export interface PairResult {
  device: RemoteDeviceInfo;
  /** Shown once, never stored. */
  rawToken: string;
  /** `https://<tunnel-host>/#<token>`, or null with no tunnel running. */
  pairingUrl: string | null;
}

/** The heavy half of remote control, loaded on first real use. */
export interface RemoteControlRuntime {
  server: RemoteControlServer;
  tunnel: TunnelManager;
}

export class RemoteControlController {
  private detected: Record<TunnelKind, boolean> = {
    tailscale: false,
    cloudflared: false,
  };
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
      runtime.tunnel.onStatus(() => this.emit());
      return runtime;
    });
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
      detected: { ...this.detected },
      encryptionAvailable: this.encryptionAvailable(),
    };
  }

  /**
   * Re-probe PATH. Cheap, and the user may have installed a tool since launch.
   * Does not load the runtime: opening the settings panel must not.
   */
  async refreshDetection(): Promise<RemoteControlStatus> {
    this.detected = await detectTunnelTools(this.which);
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
    // A `full` device is a browser that wants the whole app, so its link
    // lands on `/app` (ADR-178); the other two tiers get the phone client at
    // `/`. Same fragment either way — the page reads and strips it.
    const page = capability === "full" ? "/app" : "/";
    return {
      device,
      rawToken,
      pairingUrl: url ? `${url}${page}#${rawToken}` : null,
    };
  }

  revoke(id: string): RemoteControlStatus {
    this.deviceStore.revoke(id);
    this.emit();
    return this.status();
  }

  /**
   * Start a tunnel. `kind` comes from the user's confirmation dialog; when
   * omitted we take the preferred one, which is Tailscale whenever it exists.
   */
  async startTunnel(kind?: TunnelKind): Promise<RemoteControlStatus> {
    const runtime = this.closed ? null : await this.ensureRuntime();
    if (!runtime || this.closed || !runtime.server.running) {
      throw new Error("Enable remote control before starting a tunnel.");
    }
    const { server, tunnel } = runtime;
    const chosen = kind ?? (await tunnel.preferredKind());
    if (!chosen) {
      throw new Error(
        "Neither tailscale nor cloudflared is on PATH. Manor does not install " +
          "either — install one and try again.",
      );
    }
    // Remote control may have been turned off (or the app quit) while PATH
    // was probed; spawning now would expose nothing, or outlive the app.
    if (this.closed || !server.running) {
      throw new Error("Enable remote control before starting a tunnel.");
    }
    await tunnel.start(chosen, server.serverPort);
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
