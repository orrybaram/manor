/**
 * HostProvider — what sits between a persisted `HostSpec` and the
 * `HostTransport` a `RemoteBackend` rides (ADR-178 §1).
 *
 * A bring-your-own ssh box is the only provider today. Managed sandboxes
 * (Sprites, Daytona, E2B) differ in how the box is reached, whether it
 * auto-sleeps and whether sleep keeps memory; each becomes one more
 * implementation of this interface rather than a change to the registry.
 */

import type { HostTransport } from "../../terminal-host/transport";

/**
 * Whether the box itself is there — distinct from the registry's connection
 * status (`HostStatus` in `registry.ts`), which is about Manor's link to it.
 */
export type HostProviderStatus = "up" | "sleeping" | "unreachable" | "error";

export interface HostProviderCapabilities {
  /** The box sleeps on its own when idle (see `setBusy`). */
  autoSleep: boolean;
  /** Sleep keeps processes alive; without it a wake is a reboot. */
  persistsMemory: boolean;
  /** The provider can hand out a public URL for a port (`previewUrl`). */
  previewUrls: boolean;
}

/** A local port that reaches a port on the box, until disposed. */
export interface PortForward {
  localPort: number;
  dispose(): void;
}

export interface HostProvider {
  readonly kind: "ssh";
  readonly capabilities: HostProviderCapabilities;
  /** Start or resume the box. Called before every explicit connect. */
  ensureUp(): Promise<void>;
  status(): Promise<HostProviderStatus>;
  /** The transport a `TerminalHostClient` uses to reach the box's daemon. */
  transport(): HostTransport;
  /**
   * Make `remotePort` on the box reachable at a local port. With
   * `preferredLocalPort`, that port is used when it is free (so a forward
   * recreated after a reconnect keeps its URL); otherwise any free one.
   */
  forwardPort(
    remotePort: number,
    opts?: { preferredLocalPort?: number },
  ): Promise<PortForward>;
  /** A public URL for `remotePort`, where `capabilities.previewUrls`. */
  previewUrl?(remotePort: number): Promise<string>;
  /**
   * Keep-awake hint for `autoSleep` providers: true while an agent on the
   * box is working, false once all are idle. Called only on change.
   */
  setBusy?(busy: boolean): void;
  /**
   * Release what the provider holds of its own (port forwards). Does not
   * dispose the transport — its client owns that.
   */
  dispose(): Promise<void>;
}
