/**
 * Hook feed — delivers a remote host's journaled agent hooks to Electron
 * main, in order, exactly once (ADR-178 §2).
 *
 * The remote daemon journals every hook with a consecutive `seq` and
 * broadcasts it live as a `hookEvent`. Main remembers, per host, the last
 * `seq` it ingested and the journal's `epoch` (`HookSeqStore`, persisted in
 * projects.json). On every (re)connect the feed:
 *
 *   1. holds live `hookEvent`s,
 *   2. records the host's sessions (`beforeCatchUp`), so what the replayed
 *      hooks cause is routed to the host they came from,
 *   3. asks the daemon for everything after `lastSeq` and ingests it,
 *   4. drains the held events, skipping any `seq <= lastSeq` (they were in
 *      the replay too),
 *
 * and only then goes live. Order matters: the hook relay's late-active guard
 * (`hook-relay-transition.ts`) assumes events arrive in the order they fired.
 * A live event that skips a seq means one went missing, so the feed goes
 * back to the journal rather than ingest out of order.
 *
 * Replayed and drained events are ingested with `replay: true` and followed
 * by `replayFinished`, which is how notifications get coalesced — see
 * `NotificationCoalescer`.
 *
 * The first time the feed meets a host's journal (nothing stored), it does
 * not replay it: that history — days of SessionStarts for agents long gone —
 * predates this app knowing the host, and replaying it would conjure phantom
 * agents. It fast-forwards to the journal's head instead.
 *
 * When the journal no longer has everything after `lastSeq` (compacted past
 * it while the laptop was away), the feed replays what is there, logs the
 * gap, and moves on. When the journal's epoch differs from the stored one
 * (or, for a journal without epochs, its seq is *behind* `lastSeq`), it was
 * recreated (box reinstalled, file deleted) and holds only hooks from after
 * that; the feed replays all of it.
 */

import type { AgentInfo } from "../agent-persistence";
import type { AgentStatus, HookPayload, HookReplay } from "../terminal-host/types";

/** How far into which journal a host's hooks have been ingested. */
export interface HookCursor {
  seq: number;
  /** The journal's epoch; null if it had none (or we never learned it). */
  epoch: string | null;
}

/** Where each host's cursor is kept. */
export interface HookSeqStore {
  /** Null when this host's journal has never been met. */
  get(hostId: string): HookCursor | null;
  set(hostId: string, cursor: HookCursor): void;
}

/** Where a host's hooks go — `AgentHookServer.ingestHookPayload` in the app. */
export interface HookSink {
  ingest(payload: HookPayload, ctx: { hostId: string; replay: boolean }): void;
  /** A catch-up (replay + drain) finished for `hostId`. */
  replayFinished?(hostId: string): void;
}

type ReplaySource = (
  sinceSeq: number,
  opts?: { headOnly?: boolean },
) => Promise<HookReplay | null>;

export interface HostHookFeedOptions {
  hostId: string;
  /** The host daemon's `replayHooks`. */
  replay: ReplaySource;
  store: HookSeqStore;
  /** Read at each catch-up; null means "not wired yet", and the feed waits. */
  sink: () => HookSink | null;
  /**
   * Run before each catch-up's replay — the registry records the host's
   * sessions here so effects of replayed hooks route to this host. A
   * failure is logged and the catch-up goes ahead.
   */
  beforeCatchUp?: () => Promise<void>;
  /** Delay before retrying a failed replay; defaults to 1s doubling to 30s. */
  retryDelayMs?: (attempt: number) => number;
}

/** Live events held during a catch-up; past this they are left to the journal. */
const MAX_HELD = 10_000;

function defaultRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 30_000);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class HostHookFeed {
  private cursor: HookCursor | null;
  /**
   * `idle` — not caught up (never connected, disconnected, or waiting to
   * retry); live events are held. `replaying` — a catch-up is running; live
   * events are held. `live` — caught up; live events are ingested directly.
   */
  private mode: "idle" | "replaying" | "live" = "idle";
  private held: Array<{ seq: number; payload: HookPayload }> = [];
  /** Held events were dropped (MAX_HELD); the next catch-up must rerun. */
  private overflowed = false;
  /** Another catch-up was asked for while one was running. */
  private rerun = false;
  /** Bumped by `pause()` so a catch-up in flight discards its result. */
  private generation = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  /** Callers of `catchUp` waiting for the catch-up in progress to settle. */
  private settleWaiters: Array<() => void> = [];
  private readonly retryDelayMs: (attempt: number) => number;

  constructor(private readonly opts: HostHookFeedOptions) {
    this.cursor = opts.store.get(opts.hostId);
    this.retryDelayMs = opts.retryDelayMs ?? defaultRetryDelayMs;
  }

  /** The last seq ingested (0 before the journal was first met). */
  get seq(): number {
    return this.cursor?.seq ?? 0;
  }

  private get lastSeq(): number {
    return this.seq;
  }

  /** A `hookEvent` from the host's daemon. */
  onLiveEvent(seq: number, payload: HookPayload): void {
    if (this.mode === "live") {
      if (seq <= this.lastSeq) return;
      if (seq === this.lastSeq + 1) {
        this.ingest(seq, payload, false);
        return;
      }
      console.warn(
        `[hook-feed] ${this.opts.hostId}: live hook seq ${seq} after ${this.lastSeq}; catching up from the journal`,
      );
      this.hold(seq, payload);
      void this.catchUp();
      return;
    }
    this.hold(seq, payload);
  }

  /**
   * The host is connected: catch up from the journal, then go live.
   *
   * The promise settles (never rejects) once this catch-up is over: the feed
   * went live, its replay failed (a retry is scheduled — nobody should wait
   * on that), or it was paused. With no sink yet it settles at once. The
   * registry waits on it so panes reattach after replayed hooks have set
   * their agents' status (ADR-178 §6).
   */
  catchUp(): Promise<void> {
    const settled = new Promise<void>((resolve) => this.settleWaiters.push(resolve));
    if (this.mode === "replaying") {
      this.rerun = true;
      return settled;
    }
    this.clearRetry();
    const sink = this.opts.sink();
    if (!sink) {
      this.settle();
      return settled;
    }
    this.mode = "replaying";
    void this.runCatchUp(++this.generation, sink);
    return settled;
  }

  private settle(): void {
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** The host went away. Held events are dropped — the journal has them. */
  pause(): void {
    this.settle();
    this.generation++;
    this.clearRetry();
    this.mode = "idle";
    this.held = [];
    this.overflowed = false;
    this.rerun = false;
    this.retryAttempt = 0;
  }

  private hold(seq: number, payload: HookPayload): void {
    if (this.held.length < MAX_HELD) this.held.push({ seq, payload });
    else this.overflowed = true;
  }

  private async runCatchUp(generation: number, sink: HookSink): Promise<void> {
    const { hostId } = this.opts;
    let result: HookReplay | null;
    try {
      if (this.opts.beforeCatchUp) {
        try {
          await this.opts.beforeCatchUp();
        } catch (err) {
          console.warn(`[hook-feed] ${hostId}: beforeCatchUp failed (${errorMessage(err)}); replaying anyway`);
        }
        if (generation !== this.generation) return;
      }
      const cursor = this.cursor;
      if (cursor === null) {
        result = await this.opts.replay(0, { headOnly: true });
        if (generation !== this.generation) return;
        if (result) {
          console.info(
            `[hook-feed] ${hostId}: first contact with its hook journal; starting at seq ${result.lastSeq} without replaying its history`,
          );
          this.setCursor({ seq: result.lastSeq, epoch: result.epoch ?? null });
          // A daemon that predates `headOnly` sends entries anyway.
          result = { ...result, entries: [] };
        }
      } else {
        result = await this.opts.replay(cursor.seq);
        if (generation !== this.generation) return;
        if (result && isReset(cursor, result)) {
          console.warn(
            `[hook-feed] ${hostId}: hook journal was recreated (epoch ${cursor.epoch ?? "?"} → ${result.epoch ?? "?"}, seq ${cursor.seq} → ${result.lastSeq}); replaying it from the start`,
          );
          this.setCursor({ seq: 0, epoch: result.epoch ?? null });
          result = await this.opts.replay(0);
        } else if (result?.epoch && cursor.epoch !== result.epoch) {
          // Stored before epochs existed: adopt this journal's.
          this.setCursor({ seq: cursor.seq, epoch: result.epoch });
        }
      }
    } catch (err) {
      if (generation !== this.generation) return;
      const delay = this.retryDelayMs(this.retryAttempt++);
      console.warn(
        `[hook-feed] ${hostId}: replay failed (${errorMessage(err)}); retrying in ${delay}ms`,
      );
      this.mode = "idle";
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.catchUp();
      }, delay);
      this.settle();
      return;
    }
    if (generation !== this.generation) return;
    this.retryAttempt = 0;

    if (result === null) {
      console.warn(`[hook-feed] ${hostId}: daemon has no hook journal; agent hooks there are not delivered`);
    } else {
      const first = result.entries.find((e) => e.seq > this.lastSeq);
      const firstAvailable = first?.seq ?? result.lastSeq + 1;
      if (firstAvailable > this.lastSeq + 1) {
        console.warn(
          `[hook-feed] ${hostId}: journal no longer has seq ${this.lastSeq + 1}–${firstAvailable - 1} (compacted); replaying what remains`,
        );
      }
      for (const entry of result.entries) {
        if (entry.seq <= this.lastSeq) continue;
        this.ingest(entry.seq, entry.payload, true, sink);
      }
      if (result.lastSeq > this.lastSeq) this.setLastSeq(result.lastSeq);
    }

    const held = this.held.sort((a, b) => a.seq - b.seq);
    this.held = [];
    let gap = this.overflowed;
    this.overflowed = false;
    for (const event of held) {
      if (event.seq <= this.lastSeq) continue;
      if (event.seq !== this.lastSeq + 1) {
        gap = true;
        break;
      }
      this.ingest(event.seq, event.payload, true, sink);
    }
    this.mode = "live";
    try {
      sink.replayFinished?.(hostId);
    } catch (err) {
      console.error(`[hook-feed] ${hostId}: replayFinished threw:`, err);
    }
    this.settle();
    if (gap || this.rerun) {
      this.rerun = false;
      void this.catchUp();
    }
  }

  private ingest(
    seq: number,
    payload: HookPayload,
    replay: boolean,
    sink = this.opts.sink(),
  ): void {
    try {
      sink?.ingest(payload, { hostId: this.opts.hostId, replay });
    } catch (err) {
      // A hook the relay chokes on must not wedge the feed behind it.
      console.error(`[hook-feed] ${this.opts.hostId}: ingesting seq ${seq} threw:`, err);
    }
    this.setLastSeq(seq);
  }

  private setLastSeq(seq: number): void {
    this.setCursor({ seq, epoch: this.cursor?.epoch ?? null });
  }

  private setCursor(cursor: HookCursor): void {
    this.cursor = cursor;
    this.opts.store.set(this.opts.hostId, cursor);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

/**
 * Whether `replay` comes from a different journal than `cursor` was
 * recorded against: a different epoch, or — when either side has none — a
 * head behind the cursor.
 */
function isReset(cursor: HookCursor, replay: HookReplay): boolean {
  if (cursor.epoch && replay.epoch) return cursor.epoch !== replay.epoch;
  return replay.lastSeq < cursor.seq;
}

/** In-memory `HookSeqStore`, for a registry with nowhere to persist. */
export function memoryHookSeqStore(): HookSeqStore {
  const cursors = new Map<string, HookCursor>();
  return {
    get: (hostId) => cursors.get(hostId) ?? null,
    set: (hostId, cursor) => void cursors.set(hostId, cursor),
  };
}

type NotifyFn = (
  agent: AgentInfo,
  prevStatus: string | null | undefined,
  newStatus: AgentStatus,
) => void;

/**
 * Notification coalescing for hook replay (ADR-178 §2).
 *
 * A laptop that was closed for a night can replay hundreds of hooks at once;
 * notifying for each would bury the user. While a replayed hook is being
 * ingested (`hold`), notification calls are recorded per agent instead of
 * sent — the last one wins, since it carries the agent's final status and
 * the transition into it. `flush` then sends at most one per agent, and the
 * usual rules decide whether that one is worth a banner (a replay that ends
 * with the agent working again sends nothing).
 *
 * Calls made outside `hold` — local hooks, live remote hooks, sweeps — pass
 * straight through, even while a replay is in progress.
 */
export class NotificationCoalescer {
  private holdingFor: string | null = null;
  private readonly held = new Map<string, Map<string, Parameters<NotifyFn>>>();

  constructor(private readonly notify: NotifyFn) {}

  /** The notification function to hand the hook relay. */
  readonly send: NotifyFn = (agent, prevStatus, newStatus) => {
    if (this.holdingFor === null) {
      this.notify(agent, prevStatus, newStatus);
      return;
    }
    let perAgent = this.held.get(this.holdingFor);
    if (!perAgent) {
      perAgent = new Map();
      this.held.set(this.holdingFor, perAgent);
    }
    // Delete first so the flush order follows each agent's latest call.
    perAgent.delete(agent.id);
    perAgent.set(agent.id, [agent, prevStatus, newStatus]);
  };

  /** Run `fn` (a replayed ingest for `hostId`), holding its notifications. */
  hold(hostId: string, fn: () => void): void {
    const outer = this.holdingFor;
    this.holdingFor = hostId;
    try {
      fn();
    } finally {
      this.holdingFor = outer;
    }
  }

  /** Send what `hostId`'s replay held: one per agent, its final state. */
  flush(hostId: string): void {
    const perAgent = this.held.get(hostId);
    if (!perAgent) return;
    this.held.delete(hostId);
    for (const args of perAgent.values()) {
      try {
        this.notify(...args);
      } catch (err) {
        console.error("[hook-feed] coalesced notification threw:", err);
      }
    }
  }
}
