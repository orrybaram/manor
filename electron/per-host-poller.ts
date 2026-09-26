/**
 * PerHostPoller — the one per-host polling loop behind `PortScanner`,
 * `BranchWatcher` and `DiffWatcher` (ADR-183).
 *
 * It is fed `{ path, hostId }` entries — the host travels with the path, so
 * nothing here guesses a path's host — and scans each host's paths on that
 * host's own cadence: a slow or unreachable remote host holds back only its
 * own results, never another host's. It owns what the three pollers used to
 * hand-roll, each a little differently:
 *
 * - one scan per host at a time — a tick finding the host's previous scan
 *   still in flight skips, and an on-demand `scanHost` joins it — and that
 *   holds across `stop()`/`start()`/`reset()`;
 * - a generation guard: a scan started before `reset()` never writes into
 *   the state after it (its host is scanned afresh once it settles);
 * - `HostUnavailableError` swallowed quietly — a host that is connecting,
 *   reconnecting or down keeps its last result until it answers again;
 * - merging every host's latest result and emitting only on change.
 */

import { HostUnavailableError } from "./backend/host-view";
import type { WorkspaceBackend } from "./backend/types";

/** A path and the host it lives on. */
export interface HostPath {
  path: string;
  hostId: string;
}

/** Each host's backend — `BackendRegistry` in the app. */
export interface HostBackends {
  get(hostId: string): WorkspaceBackend;
}

export interface PerHostPollerOptions<T, M> {
  /** Log prefix, e.g. `"PortScanner"`. */
  label: string;
  /** Scan `paths`, all on `hostId`. */
  scan: (hostId: string, paths: string[]) => Promise<T>;
  /** How often to poll `hostId`, in ms. */
  intervalMs: (hostId: string) => number;
  /** Every current host's latest result, in entry order, merged into one. */
  merge: (results: T[]) => M;
  /** Called with the merged result whenever it changes. */
  emit: (merged: M) => void;
  /** Hosts polled, with no paths, while there are no entries at all. */
  hostsWhenEmpty?: readonly string[];
  now?: () => number;
}

interface InFlight {
  promise: Promise<void>;
  generation: number;
}

export class PerHostPoller<T, M = T> {
  /** Paths per host, in entry order; see `hostsWhenEmpty`. */
  private groups = new Map<string, string[]>();
  /** Latest result per host, with when it was recorded. */
  private results = new Map<string, { value: T; at: number }>();
  /** The scan in flight per host; kept across stop/start/reset. */
  private inflight = new Map<string, InFlight>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private running = false;
  private immediate = false;
  /** Bumped by `reset()`; a scan from an older generation is discarded. */
  private generation = 0;
  private last: { merged: M; json: string } | null = null;
  private scannedListeners = new Set<(hostId: string) => void>();
  private readonly now: () => number;

  constructor(private readonly opts: PerHostPollerOptions<T, M>) {
    this.now = opts.now ?? Date.now;
    this.setEntries([]);
  }

  /**
   * Replace the entries. A host no longer named loses its result; while
   * running, a newly named host starts polling and a dropped one stops.
   */
  setEntries(entries: readonly HostPath[]): void {
    const groups = new Map<string, string[]>();
    for (const { path, hostId } of entries) {
      const group = groups.get(hostId);
      if (group) group.push(path);
      else groups.set(hostId, [path]);
    }
    if (groups.size === 0) {
      for (const hostId of this.opts.hostsWhenEmpty ?? []) groups.set(hostId, []);
    }
    this.groups = groups;
    for (const hostId of Array.from(this.results.keys())) {
      if (!groups.has(hostId)) this.results.delete(hostId);
    }
    if (this.running) this.syncTimers();
  }

  /**
   * Poll every host on its interval; with `immediate`, each host (and each
   * one named later) is also scanned right away. With no hosts at all, the
   * (empty) merged result is published once, so a stale one is cleared.
   */
  start({ immediate }: { immediate: boolean }): void {
    this.stop();
    this.running = true;
    this.immediate = immediate;
    if (this.groups.size === 0) this.publish(null);
    this.syncTimers();
  }

  /** Stop polling. A scan in flight still finishes (and still blocks a second one). */
  stop(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    this.running = false;
  }

  /**
   * Forget every result. A scan in flight is discarded when it lands. With
   * `reemit`, the next merged result is emitted even if it matches the last.
   */
  reset({ reemit }: { reemit: boolean }): void {
    this.generation++;
    this.results.clear();
    if (reemit) this.last = null;
  }

  /** Whether `hostId` is being polled. */
  hasHost(hostId: string): boolean {
    return this.groups.has(hostId);
  }

  /** Whether `hostId` has a result since it was last named or reset. */
  hasResult(hostId: string): boolean {
    return this.results.has(hostId);
  }

  /** How long ago `hostId`'s result was recorded, if it has one. */
  resultAge(hostId: string): number | undefined {
    const result = this.results.get(hostId);
    return result ? this.now() - result.at : undefined;
  }

  /** Whether a scan of `hostId` is in flight. */
  isScanning(hostId: string): boolean {
    return this.inflight.has(hostId);
  }

  /** The last merged result, if any has been published. */
  latest(): M | undefined {
    return this.last?.merged;
  }

  /** Called after each result is recorded and published. */
  onHostScanned(listener: (hostId: string) => void): () => void {
    this.scannedListeners.add(listener);
    return () => this.scannedListeners.delete(listener);
  }

  /**
   * Scan `hostId` now, or join the scan of it in flight. Resolves once its
   * result is recorded; rejects with the scan's error.
   */
  scanHost(hostId: string): Promise<void> {
    const current = this.inflight.get(hostId);
    if (current) {
      if (current.generation === this.generation) return current.promise;
      // A scan from before the last reset: let it finish (one scan per host
      // at a time), then scan afresh.
      return current.promise.catch(() => {}).then(() => this.scanHost(hostId));
    }
    const paths = this.groups.get(hostId);
    if (!paths) return Promise.resolve();
    const generation = this.generation;
    const promise: Promise<void> = this.opts
      .scan(hostId, paths)
      .then((value) => {
        if (generation !== this.generation || !this.groups.has(hostId)) return;
        this.results.set(hostId, { value, at: this.now() });
        this.publish(hostId);
      })
      .finally(() => {
        if (this.inflight.get(hostId)?.promise === promise) this.inflight.delete(hostId);
        // Discarded as stale: the host still owes the current state a result.
        if (generation !== this.generation && this.running && this.groups.has(hostId)) {
          this.poll(hostId);
        }
      });
    this.inflight.set(hostId, { promise, generation });
    return promise;
  }

  /**
   * Scan every host now (joining scans in flight) and return the merged
   * result. A host that fails keeps its last result; the call rejects only
   * when every host failed.
   */
  async scanAll(): Promise<M> {
    const hostIds = Array.from(this.groups.keys());
    const settled = await Promise.allSettled(hostIds.map((id) => this.scanHost(id)));
    const failures = settled.flatMap((r, i) =>
      r.status === "rejected" ? [{ hostId: hostIds[i], err: r.reason as unknown }] : [],
    );
    if (failures.length > 0 && failures.length === hostIds.length) throw failures[0].err;
    for (const { hostId, err } of failures) this.report(hostId, err);
    return this.last?.merged ?? this.opts.merge([]);
  }

  /** Merge the current results again (e.g. the merge's inputs changed); emits on change. */
  republish(): void {
    this.publish(null);
  }

  private syncTimers(): void {
    for (const [hostId, timer] of Array.from(this.timers)) {
      if (!this.groups.has(hostId)) {
        clearInterval(timer);
        this.timers.delete(hostId);
      }
    }
    for (const hostId of this.groups.keys()) {
      if (this.timers.has(hostId)) continue;
      this.timers.set(
        hostId,
        setInterval(() => this.poll(hostId), this.opts.intervalMs(hostId)),
      );
      if (this.immediate) this.poll(hostId);
    }
  }

  /** A timer tick: skipped while the host's previous scan is in flight. */
  private poll(hostId: string): void {
    if (this.inflight.has(hostId)) return;
    this.scanHost(hostId).catch((err: unknown) => this.report(hostId, err));
  }

  private report(hostId: string, err: unknown): void {
    if (err instanceof HostUnavailableError) return;
    console.error(`[${this.opts.label}] scan on ${hostId} failed:`, err);
  }

  /** Merge and emit on change; then tell listeners `hostId` was scanned. */
  private publish(hostId: string | null): void {
    const results: T[] = [];
    for (const id of this.groups.keys()) {
      const result = this.results.get(id);
      if (result) results.push(result.value);
    }
    const merged = this.opts.merge(results);
    const json = JSON.stringify(merged);
    const changed = json !== this.last?.json;
    this.last = { merged, json };
    if (changed) this.opts.emit(merged);
    if (hostId === null) return;
    for (const listener of this.scannedListeners) {
      try {
        listener(hostId);
      } catch (err) {
        console.error(`[${this.opts.label}] host-scan listener threw:`, err);
      }
    }
  }
}
