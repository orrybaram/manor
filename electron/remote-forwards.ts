/**
 * RemoteForwards — local ports that reach dev servers on remote hosts
 * (ADR-178 §5).
 *
 * A remote project's dev server listens on the box's loopback, which this
 * machine cannot reach. When the user opens one of its ports, main asks the
 * host's provider for a forward and substitutes the forward's local port in
 * the URL. Forwards are cached per (host, remote port) and outlive the
 * connection they ride:
 *
 * - When the host stops being `connected` (disconnect, reconnect, error) its
 *   forwards are disposed — they died with the ssh master anyway — but
 *   remembered, with the local port each had.
 * - When the host is `connected` again every remembered forward is
 *   recreated, on the same local port if it is still free, so a page left
 *   open in a webview comes back at the same URL.
 * - When the host is unregistered its forwards are forgotten.
 *
 * Forwards are created lazily, never for a port nobody opened.
 */

import type { HostProvider, PortForward } from "./backend/providers/types";
import type { HostStatus, HostStatusInfo } from "./backend/registry";
import type { ActivePort } from "./backend/types";

/** The slice of `BackendRegistry` forwards need. */
export interface ForwardHosts {
  provider(hostId: string): HostProvider | undefined;
  status(hostId: string): HostStatus | undefined;
  onStatusChange(handler: (hosts: HostStatusInfo[]) => void): () => void;
}

interface ForwardEntry {
  remotePort: number;
  /** The live forward, if any. */
  forward: PortForward | null;
  /** The provider `forward` came from; a replaced host has a new one. */
  provider: HostProvider | null;
  /** The local port the last forward had — preferred when recreating. */
  lastLocalPort: number | null;
  pending: Promise<number> | null;
  /** Bumped whenever the live forward is dropped; stale creations dispose. */
  generation: number;
}

export class RemoteForwards {
  private readonly hosts = new Map<string, Map<number, ForwardEntry>>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;

  constructor(private readonly registry: ForwardHosts) {
    this.unsubscribe = registry.onStatusChange((hosts) => this.onStatus(hosts));
  }

  /**
   * The local port reaching `remotePort` on `hostId`, creating the forward
   * if need be. Rejects when the host is not connected — the port is still
   * remembered, and forwarded as soon as the host connects.
   */
  ensure(hostId: string, remotePort: number): Promise<number> {
    let entries = this.hosts.get(hostId);
    if (!entries) {
      entries = new Map();
      this.hosts.set(hostId, entries);
    }
    let entry = entries.get(remotePort);
    if (!entry) {
      entry = {
        remotePort,
        forward: null,
        provider: null,
        lastLocalPort: null,
        pending: null,
        generation: 0,
      };
      entries.set(remotePort, entry);
    }
    const provider = this.registry.provider(hostId);
    if (entry.forward && entry.provider === provider) {
      return Promise.resolve(entry.forward.localPort);
    }
    if (entry.pending) return entry.pending;
    if (this.registry.status(hostId) !== "connected" || !provider) {
      return Promise.reject(
        new Error(`Cannot forward port ${remotePort}: host "${hostId}" is not connected`),
      );
    }
    return this.create(hostId, entry, provider);
  }

  /** The live local port for `remotePort` on `hostId`, without creating one. */
  localPort(hostId: string, remotePort: number): number | undefined {
    const entry = this.hosts.get(hostId)?.get(remotePort);
    if (!entry?.forward) return undefined;
    if (entry.provider !== this.registry.provider(hostId)) return undefined;
    return entry.forward.localPort;
  }

  /** Called whenever a forward appears or goes away. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Dispose every forward and stop following the registry. */
  dispose(): void {
    this.unsubscribe();
    for (const entries of this.hosts.values()) {
      for (const entry of entries.values()) this.drop(entry);
    }
    this.hosts.clear();
  }

  // ── Internals ──

  private create(
    hostId: string,
    entry: ForwardEntry,
    provider: HostProvider,
  ): Promise<number> {
    const generation = entry.generation;
    const pending: Promise<number> = provider
      .forwardPort(
        entry.remotePort,
        entry.lastLocalPort !== null ? { preferredLocalPort: entry.lastLocalPort } : undefined,
      )
      .then((forward) => {
        const current =
          this.hosts.get(hostId)?.get(entry.remotePort) === entry &&
          entry.generation === generation &&
          this.registry.provider(hostId) === provider;
        if (!current) {
          forward.dispose();
          throw new Error(
            `Port forward to ${hostId}:${entry.remotePort} was cancelled`,
          );
        }
        entry.forward = forward;
        entry.provider = provider;
        entry.lastLocalPort = forward.localPort;
        this.emitChange();
        return forward.localPort;
      })
      .finally(() => {
        if (entry.pending === pending) entry.pending = null;
      });
    entry.pending = pending;
    return pending;
  }

  /** Dispose `entry`'s live forward (best effort), keeping it remembered. */
  private drop(entry: ForwardEntry): boolean {
    entry.generation++;
    entry.pending = null;
    const forward = entry.forward;
    if (!forward) return false;
    entry.forward = null;
    entry.provider = null;
    try {
      forward.dispose();
    } catch {
      // The master may be gone already, taking the forward with it.
    }
    return true;
  }

  private onStatus(hosts: HostStatusInfo[]): void {
    let changed = false;
    for (const [hostId, entries] of Array.from(this.hosts)) {
      const info = hosts.find((h) => h.hostId === hostId);
      if (!info) {
        // Unregistered: nothing to come back to.
        for (const entry of entries.values()) changed = this.drop(entry) || changed;
        this.hosts.delete(hostId);
        continue;
      }
      if (info.status !== "connected") {
        for (const entry of entries.values()) changed = this.drop(entry) || changed;
        continue;
      }
      const provider = this.registry.provider(hostId);
      if (!provider) continue;
      for (const entry of entries.values()) {
        if (entry.forward && entry.provider !== provider) {
          // The host was replaced; its old provider cancelled this forward.
          changed = this.drop(entry) || changed;
        }
        if (entry.forward || entry.pending) continue;
        this.create(hostId, entry, provider).catch((err: unknown) => {
          console.warn(
            `[remote-forwards] recreating forward ${hostId}:${entry.remotePort} failed:`,
            err instanceof Error ? err.message : err,
          );
        });
      }
    }
    if (changed) this.emitChange();
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error("[remote-forwards] change listener threw:", err);
      }
    }
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The URL to open for `url` in a remote host's context: a loopback URL whose
 * port the host's latest scan reports is rewritten to the forward's local
 * port; a portless `.localhost` URL of such a port is left as is, but the
 * forward behind its route is made to exist. Anything else — a port the
 * scan did not report, another host, a non-http URL — is returned untouched,
 * since it may well mean this machine.
 *
 * `remotePorts` is the host's latest scan; `ensure` returns the local port
 * forwarding a remote one.
 */
export async function resolveRemotePortUrl(
  url: string,
  remotePorts: readonly ActivePort[],
  ensure: (remotePort: number) => Promise<number>,
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;

  const hostname = parsed.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(hostname)) {
    const port = parsed.port
      ? Number(parsed.port)
      : parsed.protocol === "https:"
        ? 443
        : 80;
    if (!remotePorts.some((p) => p.port === port)) return url;
    parsed.port = String(await ensure(port));
    return parsed.toString();
  }

  if (hostname.endsWith(".localhost")) {
    const match = remotePorts.find(
      (p) => p.hostname !== null && p.hostname.toLowerCase() === parsed.host.toLowerCase(),
    );
    if (match) await ensure(match.port);
  }
  return url;
}
