import type { BrowserWindow } from "electron";
import { LOCAL_HOST_ID, type ActivePort, type PortsBackend } from "./backend/types";
import { groupPathsByHost, type HostForPath } from "./backend/routed-backend";
import { HostUnavailableError } from "./backend/registry";

export type { ActivePort };

/**
 * An on-demand `scanHost` reuses a scan of the host that finished this
 * recently instead of running another one.
 */
export const RESCAN_MIN_MS = 3000;

/**
 * Polls listening ports for the open workspaces. Workspaces are scanned per
 * host, each host on its own cadence: a slow or unreachable remote host
 * holds back only its own results, never the local ones.
 */
export class PortScanner {
  private workspacePaths: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPorts: ActivePort[] = [];
  /**
   * The scan in flight per host. The poller and `scanHost` share it, so a
   * host is never scanned twice at once however many callers ask.
   */
  private inflight = new Map<string, Promise<ActivePort[]>>();
  /** Latest scan result per host. */
  private hostPorts = new Map<string, ActivePort[]>();
  /** Sequence number of the scan each host's `hostPorts` entry came from. */
  private appliedSeq = new Map<string, number>();
  /** When each host's `hostPorts` entry was last written. */
  private scannedAt = new Map<string, number>();
  private scanSeq = 0;
  private generation = 0;
  private hostScanListeners = new Set<(hostId: string) => void>();
  private backend: PortsBackend;
  private hostForPath: HostForPath;

  constructor(
    backend: PortsBackend,
    hostForPath: HostForPath = () => LOCAL_HOST_ID,
    private readonly now: () => number = Date.now,
  ) {
    this.backend = backend;
    this.hostForPath = hostForPath;
  }

  start(
    window: BrowserWindow,
    onScan?: (ports: ActivePort[]) => ActivePort[],
  ): void {
    this.stop();
    const generation = ++this.generation;

    this.timer = setInterval(() => {
      const groups = this.groups();
      for (const hostId of Array.from(this.hostPorts.keys())) {
        if (!groups.has(hostId)) this.forgetHost(hostId);
      }
      for (const [hostId, paths] of groups) {
        if (this.inflight.has(hostId)) continue;
        this.runScan(hostId, paths)
          .then(
            () => {
              if (generation !== this.generation) return;
              const merged = Array.from(groups.keys()).flatMap(
                (id) => this.hostPorts.get(id) ?? [],
              );
              const enriched = onScan ? onScan(merged) : merged;
              // After onScan, so listeners see the enriched result.
              this.emitHostScanned(hostId);
              if (JSON.stringify(enriched) !== JSON.stringify(this.lastPorts)) {
                window.webContents.send("ports-changed", enriched);
                this.lastPorts = enriched;
              }
            },
            (err: unknown) => {
              // A remote host that is connecting, reconnecting or down keeps
              // its last known ports, quietly, until it answers again.
              if (err instanceof HostUnavailableError) return;
              console.error(`[PortScanner] scan on ${hostId} failed:`, err);
            },
          );
      }
    }, 3000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Whether `hostId` has been scanned successfully since its paths appeared. */
  hasScanned(hostId: string): boolean {
    return this.hostPorts.has(hostId);
  }

  /** Called after each successful scan of a host by the poller. */
  onHostScanned(listener: (hostId: string) => void): () => void {
    this.hostScanListeners.add(listener);
    return () => this.hostScanListeners.delete(listener);
  }

  updateWorkspacePaths(paths: string[]): void {
    this.workspacePaths = paths;
  }

  async scanNow(): Promise<ActivePort[]> {
    const groups = this.groups();
    if (groups.size === 1) {
      const [paths] = groups.values();
      return this.backend.scan(paths);
    }
    // A remote host that cannot answer contributes nothing, rather than
    // failing the local result with it.
    const results = await Promise.allSettled(
      Array.from(groups, ([hostId, paths]) =>
        this.backend.scan(paths).catch((err: unknown) => {
          if (hostId === LOCAL_HOST_ID) throw err;
          if (err instanceof HostUnavailableError) {
            return this.hostPorts.get(hostId) ?? [];
          }
          console.error(`[PortScanner] scan on ${hostId} failed:`, err);
          return [];
        }),
      ),
    );
    return results.flatMap((r) => {
      if (r.status === "rejected") throw r.reason;
      return r.value;
    });
  }

  /**
   * Scan `hostId` right away, outside the poller's cadence, and record the
   * result as its latest. Resolves with every host's latest ports (this one
   * fresh), or null when the host has no open workspaces or cannot answer.
   * For a URL naming a port a remote dev server opened since the last poll
   * (ADR-178 §5).
   */
  async scanHost(hostId: string): Promise<ActivePort[] | null> {
    const paths = this.groups().get(hostId);
    if (!paths) return null;
    // Join a scan already running; skip one entirely if the host was just
    // scanned — N callers at once must not mean N scans of a remote host.
    const scannedAt = this.scannedAt.get(hostId);
    const fresh =
      this.hostPorts.has(hostId) &&
      scannedAt !== undefined &&
      this.now() - scannedAt < RESCAN_MIN_MS;
    if (!fresh || this.inflight.has(hostId)) {
      try {
        await this.runScan(hostId, paths);
      } catch (err) {
        if (!(err instanceof HostUnavailableError)) {
          console.error(`[PortScanner] scan on ${hostId} failed:`, err);
        }
        return null;
      }
      this.emitHostScanned(hostId);
    }
    return Array.from(this.groups().keys()).flatMap((id) => this.hostPorts.get(id) ?? []);
  }

  /**
   * Scan `hostId`, or join the scan of it already in flight. A result is
   * recorded only if it is newer than the one recorded — a slow scan that
   * finishes after a later one must not put older ports back — and only
   * while the host still has open workspaces.
   */
  private runScan(hostId: string, paths: string[]): Promise<ActivePort[]> {
    const running = this.inflight.get(hostId);
    if (running) return running;
    const seq = ++this.scanSeq;
    const scan = this.backend
      .scan(paths)
      .then((ports) => {
        const applied = this.appliedSeq.get(hostId) ?? 0;
        if (seq > applied && this.groups().has(hostId)) {
          this.appliedSeq.set(hostId, seq);
          this.hostPorts.set(hostId, ports);
          this.scannedAt.set(hostId, this.now());
        }
        return ports;
      })
      .finally(() => {
        if (this.inflight.get(hostId) === scan) this.inflight.delete(hostId);
      });
    this.inflight.set(hostId, scan);
    return scan;
  }

  private forgetHost(hostId: string): void {
    this.hostPorts.delete(hostId);
    this.scannedAt.delete(hostId);
  }

  private emitHostScanned(hostId: string): void {
    for (const listener of this.hostScanListeners) {
      try {
        listener(hostId);
      } catch (err) {
        console.error("[PortScanner] host-scan listener threw:", err);
      }
    }
  }

  /** Workspace paths by host; the local host even with no paths. */
  private groups(): Map<string, string[]> {
    const groups = groupPathsByHost(this.workspacePaths, this.hostForPath);
    return groups.size === 0 ? new Map([[LOCAL_HOST_ID, []]]) : groups;
  }
}
