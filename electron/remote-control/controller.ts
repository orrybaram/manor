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
 */

import type { RemoteDeviceInfo, RemoteDeviceStore } from "./devices";
import type { RemoteControlServer } from "./server";
import type { TunnelKind, TunnelManager, TunnelStatus } from "./tunnel";

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

export class RemoteControlController {
  private detected: Record<TunnelKind, boolean> = {
    tailscale: false,
    cloudflared: false,
  };
  private listeners = new Set<(status: RemoteControlStatus) => void>();

  constructor(
    private readonly server: RemoteControlServer,
    private readonly deviceStore: RemoteDeviceStore,
    private readonly tunnel: TunnelManager,
    private readonly encryptionAvailable: () => boolean,
  ) {
    this.tunnel.onStatus(() => this.emit());
  }

  onChange(listener: (status: RemoteControlStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(): RemoteControlStatus {
    return {
      enabled: this.server.running,
      port: this.server.running ? this.server.serverPort : null,
      devices: this.deviceStore.list(),
      tunnel: this.tunnel.status,
      detected: { ...this.detected },
      encryptionAvailable: this.encryptionAvailable(),
      listeners: this.server.listenerCount,
    };
  }

  /** Re-probe PATH. Cheap, and the user may have installed a tool since launch. */
  async refreshDetection(): Promise<RemoteControlStatus> {
    this.detected = await this.tunnel.detect();
    this.emit();
    return this.status();
  }

  async setEnabled(enabled: boolean): Promise<RemoteControlStatus> {
    if (enabled) {
      await this.server.start();
      await this.refreshDetection();
    } else {
      // Order matters: drop the exposure before the thing being exposed, so
      // there is no window where a tunnel points at a closing listener.
      await this.tunnel.stop();
      await this.server.stop();
    }
    this.emit();
    return this.status();
  }

  pair(label: string, canSend: boolean): PairResult {
    const { device, rawToken } = this.deviceStore.pair(label, canSend);
    const url = this.tunnel.status.url;
    this.emit();
    return {
      device,
      rawToken,
      pairingUrl: url ? `${url}/#${rawToken}` : null,
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
    if (!this.server.running) {
      throw new Error("Enable remote control before starting a tunnel.");
    }
    const chosen = kind ?? (await this.tunnel.preferredKind());
    if (!chosen) {
      throw new Error(
        "Neither tailscale nor cloudflared is on PATH. Manor does not install " +
          "either — install one and try again.",
      );
    }
    await this.tunnel.start(chosen, this.server.serverPort);
    this.emit();
    return this.status();
  }

  async stopTunnel(): Promise<RemoteControlStatus> {
    await this.tunnel.stop();
    this.emit();
    return this.status();
  }

  /** Quit path: the tunnel must never outlive the app. */
  async shutdown(): Promise<void> {
    await this.tunnel.stop();
    await this.server.stop();
  }

  private emit(): void {
    const status = this.status();
    for (const listener of [...this.listeners]) listener(status);
  }
}
