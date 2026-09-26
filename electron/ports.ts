import type { BrowserWindow } from "electron";
import { LOCAL_HOST_ID, type ActivePort } from "./backend/types";
import { HostUnavailableError } from "./backend/host-view";
import { PerHostPoller, type HostBackends, type HostPath } from "./per-host-poller";

export type { ActivePort };

/**
 * An on-demand `scanHost` reuses a scan of the host that finished this
 * recently instead of running another one.
 */
export const RESCAN_MIN_MS = 3000;

/**
 * Polls listening ports for the open workspaces. Workspaces are scanned per
 * host, each host on its own cadence: a slow or unreachable remote host
 * holds back only its own results, never the local ones. Each host is asked
 * through its own backend, and every port comes back tagged with its host
 * (ADR-183).
 */
export class PortScanner {
  private readonly poller: PerHostPoller<ActivePort[]>;
  private window: BrowserWindow | null = null;
  /** Dresses the merged ports (portless hostnames); set by `ipc/ports.ts`. */
  private enrich: (ports: ActivePort[]) => ActivePort[] = (ports) => ports;

  constructor(
    private readonly hosts: HostBackends,
    now: () => number = Date.now,
  ) {
    this.poller = new PerHostPoller<ActivePort[]>({
      label: "PortScanner",
      scan: async (hostId, paths) => {
        const ports = await this.hosts.get(hostId).ports.scan(paths);
        return ports.map((p) => ({ ...p, hostId }));
      },
      intervalMs: () => 3000,
      merge: (results) => this.enrich(results.flat()),
      emit: (ports) => this.window?.webContents.send("ports-changed", ports),
      // With no workspaces open, this machine's ports are still listed.
      hostsWhenEmpty: [LOCAL_HOST_ID],
      now,
    });
  }

  /** Set how merged ports are dressed before they are published. */
  setEnricher(enrich: (ports: ActivePort[]) => ActivePort[]): void {
    this.enrich = enrich;
  }

  start(window: BrowserWindow): void {
    this.window = window;
    this.poller.start({ immediate: false });
  }

  stop(): void {
    this.poller.stop();
    this.window = null;
  }

  /** Whether `hostId` has been scanned successfully since its paths appeared. */
  hasScanned(hostId: string): boolean {
    return this.poller.hasResult(hostId);
  }

  /** Called after each successful scan of a host, once its ports are published. */
  onHostScanned(listener: (hostId: string) => void): () => void {
    return this.poller.onHostScanned(listener);
  }

  updateWorkspaces(entries: readonly HostPath[]): void {
    this.poller.setEntries(entries);
  }

  /** Every host's latest (enriched) ports. */
  latest(): ActivePort[] {
    return this.poller.latest() ?? [];
  }

  /** Enrich the latest ports again, e.g. after a forward appeared. */
  refresh(): void {
    this.poller.republish();
  }

  /**
   * Scan every host now. A host that cannot answer keeps its last known
   * ports rather than failing the others.
   */
  scanNow(): Promise<ActivePort[]> {
    return this.poller.scanAll();
  }

  /**
   * Scan `hostId` right away, outside the poller's cadence, and record the
   * result as its latest. Resolves with every host's latest ports (this one
   * fresh), or null when the host has no open workspaces or cannot answer.
   * For a URL naming a port a remote dev server opened since the last poll
   * (ADR-178 §5).
   */
  async scanHost(hostId: string): Promise<ActivePort[] | null> {
    if (!this.poller.hasHost(hostId)) return null;
    // Join a scan already running; skip one entirely if the host was just
    // scanned — N callers at once must not mean N scans of a remote host.
    const age = this.poller.resultAge(hostId);
    const fresh = age !== undefined && age < RESCAN_MIN_MS;
    if (!fresh || this.poller.isScanning(hostId)) {
      try {
        await this.poller.scanHost(hostId);
      } catch (err) {
        if (!(err instanceof HostUnavailableError)) {
          console.error(`[PortScanner] scan on ${hostId} failed:`, err);
        }
        return null;
      }
    }
    return this.latest();
  }

  /** The hosts whose latest scan reported `pid`, for routing a kill. */
  hostsListeningOn(pid: number): string[] {
    const hosts = new Set<string>();
    for (const port of this.latest()) {
      if (port.pid === pid) hosts.add(port.hostId);
    }
    return Array.from(hosts);
  }
}
