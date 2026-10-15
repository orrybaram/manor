/**
 * Each server's last answer to each merged read (ADR-228 D6), for the router
 * (`./router.ts`) to answer with while that server is away or fails.
 *
 * Kept in memory, and — given a `LastKnownStore` (the phone's IndexedDB,
 * `./last-known.ts`) — saved there too and read back in once per server, so
 * a reload while it is away still shows it.
 */

import type { LastKnownStore } from "./last-known";

/** One answer, found; `null` from `recall` is none. */
export interface Recalled {
  value: unknown;
}

export interface LastKnownCache {
  /** `value` is `serverId`'s answer to `memo` (`callKey`) now. */
  remember(serverId: string, memo: string, value: unknown): void;
  /**
   * `serverId`'s last answer to `memo`, its saved answers read in first —
   * under the ones this page has heard since — or null for none.
   */
  recall(serverId: string, memo: string): Promise<Recalled | null>;
  /** `serverId` left the set for good: a pairing removed or refused. */
  forget(serverId: string): void;
}

/** A stable key for one call's arguments, for its last-known answer. */
export function callKey(key: string, args: readonly unknown[]): string {
  try {
    return `${key}:${JSON.stringify(args)}`;
  } catch {
    return key;
  }
}

/**
 * `persisted` null keeps answers in memory only. `isMember` says whether a
 * server is still in the set: saved answers read in for one that has left
 * meanwhile are dropped.
 */
export function createLastKnownCache(
  persisted: LastKnownStore | null,
  isMember: (serverId: string) => boolean,
): LastKnownCache {
  /** Each server's saved answers, read in once: settles, never rejects. */
  const restoring = new Map<string, Promise<void>>();
  const lastKnown = new Map<string, Map<string, unknown>>();

  function restore(serverId: string): Promise<void> {
    if (!persisted) return Promise.resolve();
    let reading = restoring.get(serverId);
    if (!reading) {
      reading = persisted.read(serverId).then(
        (saved) => {
          if (!isMember(serverId)) return;
          const mine = lastKnown.get(serverId) ?? new Map<string, unknown>();
          for (const [memo, value] of saved) if (!mine.has(memo)) mine.set(memo, value);
          lastKnown.set(serverId, mine);
        },
        () => {},
      );
      restoring.set(serverId, reading);
    }
    return reading;
  }

  return {
    remember(serverId, memo, value) {
      let mine = lastKnown.get(serverId);
      if (!mine) {
        mine = new Map();
        lastKnown.set(serverId, mine);
      }
      mine.set(memo, value);
      persisted?.write(serverId, memo, value);
    },

    async recall(serverId, memo) {
      await restore(serverId);
      const remembered = lastKnown.get(serverId);
      return remembered?.has(memo) ? { value: remembered.get(memo) } : null;
    },

    forget(serverId) {
      lastKnown.delete(serverId);
      restoring.delete(serverId);
      persisted?.forget(serverId);
    },
  };
}
