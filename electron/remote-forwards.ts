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
  /** The box's loopback to reach: `"::1"` for a server only there. */
  remoteHost: "::1" | undefined;
  /** The live forward, if any. */
  forward: PortForward | null;
  /** The provider `forward` came from; a replaced host has a new one. */
  provider: HostProvider | null;
  /** The local port the last forward had — preferred when recreating. */
  lastLocalPort: number | null;
  pending: Promise<number> | null;
  /** The provider `pending` is asking. */
  pendingProvider: HostProvider | null;
  /** Bumped whenever the live forward is dropped; stale creations dispose. */
  generation: number;
}

export interface EnsureOptions {
  /**
   * The box's loopback the port listens on, from its scan: `"::1"` when
   * only there, anything else (or absent) for 127.0.0.1. Leave `opts` out
   * entirely to keep what an earlier call said.
   */
  remoteHost?: string;
}

export class RemoteForwards {
  private readonly hosts = new Map<string, Map<number, ForwardEntry>>();
  /**
   * Every local port a forward has had, with what it reached — kept after
   * the forward goes, so a URL still holding an old local port (a page left
   * open over a reconnect that moved the forward) can be traced back to its
   * remote port. A local port reused by another forward is overwritten.
   */
  private readonly byLocalPort = new Map<number, { hostId: string; remotePort: number }>();
  /** Each host's status and provider as of the last status event. */
  private readonly seen = new Map<
    string,
    { status: HostStatus; provider: HostProvider | undefined }
  >();
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
  ensure(hostId: string, remotePort: number, opts?: EnsureOptions): Promise<number> {
    let entries = this.hosts.get(hostId);
    if (!entries) {
      entries = new Map();
      this.hosts.set(hostId, entries);
    }
    let entry = entries.get(remotePort);
    if (!entry) {
      entry = {
        remotePort,
        remoteHost: undefined,
        forward: null,
        provider: null,
        lastLocalPort: null,
        pending: null,
        pendingProvider: null,
        generation: 0,
      };
      entries.set(remotePort, entry);
    }
    let changed = false;
    if (opts) {
      const remoteHost = opts.remoteHost === "::1" ? "::1" : undefined;
      if (remoteHost !== entry.remoteHost) {
        // The server moved to (or off) the IPv6 loopback: the old forward
        // targets the wrong address.
        entry.remoteHost = remoteHost;
        changed = this.drop(entry);
      }
    }
    const provider = this.registry.provider(hostId);
    if (entry.forward && entry.provider === provider) {
      return Promise.resolve(entry.forward.localPort);
    }
    // A forward (or a creation) from a replaced provider is dead weight:
    // release it before asking the new one.
    if (
      (entry.forward && entry.provider !== provider) ||
      (entry.pending && entry.pendingProvider !== provider)
    ) {
      changed = this.drop(entry) || changed;
    }
    if (changed) this.emitChange();
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

  /**
   * The remote port on `hostId` that `localPort` forwards (or forwarded, if
   * the forward has since moved or gone), if it ever was one of its.
   */
  remotePortFor(hostId: string, localPort: number): number | undefined {
    const known = this.byLocalPort.get(localPort);
    return known?.hostId === hostId ? known.remotePort : undefined;
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
    this.byLocalPort.clear();
  }

  // ── Internals ──

  private create(
    hostId: string,
    entry: ForwardEntry,
    provider: HostProvider,
  ): Promise<number> {
    const generation = entry.generation;
    const opts: { preferredLocalPort?: number; remoteHost?: string } = {};
    if (entry.lastLocalPort !== null) opts.preferredLocalPort = entry.lastLocalPort;
    if (entry.remoteHost) opts.remoteHost = entry.remoteHost;
    const pending: Promise<number> = provider
      .forwardPort(entry.remotePort, Object.keys(opts).length > 0 ? opts : undefined)
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
        this.byLocalPort.set(forward.localPort, { hostId, remotePort: entry.remotePort });
        this.emitChange();
        return forward.localPort;
      })
      .finally(() => {
        if (entry.pending === pending) {
          entry.pending = null;
          entry.pendingProvider = null;
        }
      });
    entry.pending = pending;
    entry.pendingProvider = provider;
    return pending;
  }

  /** Dispose `entry`'s live forward (best effort), keeping it remembered. */
  private drop(entry: ForwardEntry): boolean {
    entry.generation++;
    entry.pending = null;
    entry.pendingProvider = null;
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
    // Which hosts' status (or provider) this event changes; only those are
    // acted on, so one host's churn never retries another's forwards.
    const transitioned = new Set<string>();
    const listed = new Set<string>();
    for (const info of hosts) {
      listed.add(info.hostId);
      const provider = this.registry.provider(info.hostId);
      const prev = this.seen.get(info.hostId);
      if (!prev || prev.status !== info.status || prev.provider !== provider) {
        transitioned.add(info.hostId);
      }
      this.seen.set(info.hostId, { status: info.status, provider });
    }
    for (const hostId of Array.from(this.seen.keys())) {
      if (!listed.has(hostId)) this.seen.delete(hostId);
    }

    let changed = false;
    for (const [hostId, entries] of Array.from(this.hosts)) {
      const info = hosts.find((h) => h.hostId === hostId);
      if (!info) {
        // Unregistered: nothing to come back to.
        for (const entry of entries.values()) changed = this.drop(entry) || changed;
        this.hosts.delete(hostId);
        for (const [localPort, known] of Array.from(this.byLocalPort)) {
          if (known.hostId === hostId) this.byLocalPort.delete(localPort);
        }
        continue;
      }
      if (!transitioned.has(hostId)) continue;
      if (info.status !== "connected") {
        for (const entry of entries.values()) changed = this.drop(entry) || changed;
        continue;
      }
      const provider = this.registry.provider(hostId);
      if (!provider) continue;
      for (const entry of entries.values()) {
        if (
          (entry.forward && entry.provider !== provider) ||
          (entry.pending && entry.pendingProvider !== provider)
        ) {
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

/** The explicit or scheme-default port of a parsed http(s) URL. */
function urlPort(parsed: URL): number {
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === "https:" ? 443 : 80;
}

function parseHttpUrl(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
}

/**
 * Whether `url` is one `resolveRemotePortUrl` might act on in a remote
 * host's context — an http(s) URL on loopback or a portless `*.localhost`.
 * Anything else can be loaded as is without waiting on the host.
 */
export function isRemoteCandidateUrl(url: string): boolean {
  const parsed = parseHttpUrl(url);
  if (!parsed) return false;
  const hostname = parsed.hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost");
}

/**
 * The URL to open for `url` in a remote host's context: a loopback URL whose
 * port the host's latest scan reports is rewritten to the forward's local
 * port — on 127.0.0.1, where the forward listens (`localhost` may resolve to
 * `::1` first). So is a loopback URL still holding a forward's local port
 * (`forwardedRemotePort` traces it back to its remote port), e.g. one from a
 * page left open while a reconnect moved the forward. A portless
 * `.localhost` URL of a reported port is left as is, but the forward behind
 * its route is made to exist. Anything else — a port the scan did not
 * report, another host, a non-http URL — is returned untouched, since it
 * may well mean this machine.
 *
 * `remotePorts` is the host's latest scan; `ensure` returns the local port
 * forwarding a remote one (given its scan entry, when it has one).
 */
export async function resolveRemotePortUrl(
  url: string,
  remotePorts: readonly ActivePort[],
  ensure: (remotePort: number, scanned: ActivePort | undefined) => Promise<number>,
  forwardedRemotePort?: (localPort: number) => number | undefined,
): Promise<string> {
  const parsed = parseHttpUrl(url);
  if (!parsed) return url;

  const hostname = parsed.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(hostname)) {
    const port = urlPort(parsed);
    let scanned = remotePorts.find((p) => p.port === port);
    let remotePort = scanned?.port;
    if (remotePort === undefined) {
      remotePort = forwardedRemotePort?.(port);
      if (remotePort === undefined) return url;
      scanned = remotePorts.find((p) => p.port === remotePort);
    }
    const localPort = await ensure(remotePort, scanned);
    parsed.hostname = "127.0.0.1";
    parsed.port = String(localPort);
    return parsed.toString();
  }

  if (hostname.endsWith(".localhost")) {
    const match = remotePorts.find(
      (p) => p.hostname !== null && p.hostname.toLowerCase() === parsed.host.toLowerCase(),
    );
    if (match) await ensure(match.port, match);
  }
  return url;
}

/**
 * Whether `resolveRemotePortUrl` would leave `url` untouched only because
 * the host's latest scan does not know its port — a loopback URL whose port
 * neither the scan nor any forward accounts for, or a `.localhost` URL no
 * scanned port claims. The server may have started since the last poll, so
 * such a URL is worth one immediate rescan before it is treated as this
 * machine's.
 */
export function remotePortUnknown(
  url: string,
  remotePorts: readonly ActivePort[],
  forwardedRemotePort?: (localPort: number) => number | undefined,
): boolean {
  const parsed = parseHttpUrl(url);
  if (!parsed) return false;
  const hostname = parsed.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(hostname)) {
    const port = urlPort(parsed);
    if (remotePorts.some((p) => p.port === port)) return false;
    return forwardedRemotePort?.(port) === undefined;
  }
  if (hostname.endsWith(".localhost")) {
    return !remotePorts.some(
      (p) => p.hostname !== null && p.hostname.toLowerCase() === parsed.host.toLowerCase(),
    );
  }
  return false;
}

/**
 * The URL a remote pane should remember and show for `url`, the address it
 * actually loaded: a loopback URL on a forward's local port becomes
 * `localhost:<remote port>` — the address that means something on the box
 * and survives a restart, when forwards (and their local ports) are gone.
 * Anything else is returned as is.
 */
export function remoteFormOfUrl(
  url: string,
  forwardedRemotePort: (localPort: number) => number | undefined,
): string {
  const parsed = parseHttpUrl(url);
  if (!parsed || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return url;
  const remotePort = forwardedRemotePort(urlPort(parsed));
  if (remotePort === undefined) return url;
  parsed.hostname = "localhost";
  parsed.port = String(remotePort);
  return parsed.toString();
}
