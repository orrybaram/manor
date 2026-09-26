/**
 * The registered remote hosts in `projects.json`: how each is reached, and
 * how far its hook journal has been read (ADR-183 split this out of
 * `ProjectManager`).
 */

import { LOCAL_HOST_ID, type HostSpec } from "../backend/types";
import type { StateStore } from "./state-store";

/** How long `setHookCursor` batches writes. */
const HOOK_SEQ_SAVE_DEBOUNCE_MS = 1_000;

export class HostRecords {
  constructor(private readonly store: StateStore) {}

  /** Registered remote hosts, in the order they were added. */
  list(): Array<{ hostId: string; spec: HostSpec }> {
    return Object.entries(this.store.state.hosts ?? {}).map(([hostId, host]) => ({
      hostId,
      spec: host.spec,
    }));
  }

  /** Add a remote host, or replace how an existing one is reached. */
  save(hostId: string, spec: HostSpec): void {
    if (hostId === LOCAL_HOST_ID) {
      throw new Error(`"${LOCAL_HOST_ID}" is reserved for this machine`);
    }
    const state = this.store.state;
    if (!state.hosts) state.hosts = {};
    state.hosts[hostId] = { ...state.hosts[hostId], spec };
    this.store.save();
  }

  /** Throws unless `hostId` is this machine or a registered host. */
  assertKnown(hostId: string): void {
    if (hostId === LOCAL_HOST_ID) return;
    if (!this.store.state.hosts?.[hostId]) {
      throw new Error(`Unknown host "${hostId}".`);
    }
  }

  /** Throws unless `hostId` is a registered remote host (ADR-183). */
  assertRemote(hostId: string): void {
    if (hostId === LOCAL_HOST_ID) {
      throw new Error("A remote host is required.");
    }
    this.assertKnown(hostId);
  }

  /** How `hostId` is named in messages: its ssh target, or "this Mac". */
  label(hostId: string): string {
    if (hostId === LOCAL_HOST_ID) return "this Mac";
    return this.store.state.hosts?.[hostId]?.spec.target ?? hostId;
  }

  /**
   * How far into which hook journal `hostId`'s hooks have been ingested, or
   * null if its journal has never been met.
   */
  hookCursor(hostId: string): { seq: number; epoch: string | null } | null {
    const host = this.store.state.hosts?.[hostId];
    if (host?.lastHookSeq === undefined) return null;
    return { seq: host.lastHookSeq, epoch: host.hookJournalEpoch ?? null };
  }

  /**
   * Record the last hook-journal seq ingested from `hostId`. Hooks arrive in
   * bursts (a replay can be thousands), so the write is debounced; call
   * `flushHookCursors` on quit. A seq lost to a crash means the last
   * second's hooks are replayed once more on the next launch — into a fresh
   * relay, with notifications coalesced.
   */
  setHookCursor(hostId: string, cursor: { seq: number; epoch: string | null }): void {
    const host = this.store.state.hosts?.[hostId];
    if (!host) return;
    const epoch = cursor.epoch ?? undefined;
    if (host.lastHookSeq === cursor.seq && host.hookJournalEpoch === epoch) return;
    host.lastHookSeq = cursor.seq;
    if (epoch === undefined) delete host.hookJournalEpoch;
    else host.hookJournalEpoch = epoch;
    this.store.saveSoon(HOOK_SEQ_SAVE_DEBOUNCE_MS);
  }

  /** Write a pending `setHookCursor` now. */
  flushHookCursors(): void {
    this.store.flush();
  }
}
