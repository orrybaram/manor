/**
 * What each connection asked a watcher to watch (ADR-230 D6).
 *
 * `BranchWatcher` and `DiffWatcher` are one per server, and every connection
 * to it — each desktop window, each phone, a desktop's own bridge to a host
 * server — starts and stops them. A start used to replace the whole watched
 * list, so a phone watching its share of a host's workspaces took the
 * desktop window's away. Now each connection keeps its own list, the watcher
 * polls the union, and a connection that stops or closes takes only its own
 * away.
 */

import type { HostPath } from "./per-host-poller";

export class WatchedSets<T extends HostPath> {
  private readonly byOwner = new Map<string, readonly T[]>();

  /** Whether no connection watches anything. */
  get empty(): boolean {
    return this.byOwner.size === 0;
  }

  /** Set `owner`'s list; true when it is new or differs from its last. */
  set(owner: string, items: readonly T[]): boolean {
    const was = this.byOwner.get(owner);
    this.byOwner.set(owner, items);
    return was === undefined || JSON.stringify(was) !== JSON.stringify(items);
  }

  /** Forget `owner`'s list; true when it had one. */
  delete(owner: string): boolean {
    return this.byOwner.delete(owner);
  }

  clear(): void {
    this.byOwner.clear();
  }

  /**
   * Every owner's items, one per host and path: the first owner to name a
   * workspace decides the rest of its fields (a diff's default branch).
   */
  union(): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const items of this.byOwner.values()) {
      for (const item of items) {
        const key = `${item.hostId}\0${item.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
      }
    }
    return out;
  }
}
