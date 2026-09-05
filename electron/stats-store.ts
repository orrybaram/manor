import fs from "node:fs";
import path from "node:path";

import { manorDataDir } from "./paths";
import {
  createSignalTracker,
  deltasForHookEvent,
  type SignalTrackerState,
  type StatDelta,
} from "./stats-signals";

import type { AgentHookEvent } from "./agent-hook-events";
import type { Effect } from "./hook-relay-transition";

/**
 * Usage-stats persistence model (ADR-168).
 *
 * Mirrors the shape and conventions of `notification-store.ts`: in-memory state
 * backed by a JSON file in the data dir, writes debounced through a single
 * timer, retention pruning applied at construction and before every write.
 *
 * The file holds counts only — never prompt text, command text, file paths or
 * branch names — bucketed by **local** calendar day. Nothing leaves the machine.
 */

export type StatCounter =
  | "prompts"
  | "toolCalls"
  | "agentSessions"
  | "subagents"
  | "agentsResponded"
  | "agentsKilled"
  | "blocks"
  | "unblocks"
  | "unblockMsTotal"
  | "fastUnblocks"
  | "worktreesCreated"
  | "worktreesRemoved"
  | "worktreesMerged"
  | "prApproved"
  | "prChangesRequested"
  | "prChecksFailed";

/** Gauges aggregate with max(), not sum(). */
export type StatGauge = "maxConcurrentAgents";

export const STAT_COUNTERS: readonly StatCounter[] = [
  "prompts",
  "toolCalls",
  "agentSessions",
  "subagents",
  "agentsResponded",
  "agentsKilled",
  "blocks",
  "unblocks",
  "unblockMsTotal",
  "fastUnblocks",
  "worktreesCreated",
  "worktreesRemoved",
  "worktreesMerged",
  "prApproved",
  "prChangesRequested",
  "prChecksFailed",
];

export const STAT_GAUGES: readonly StatGauge[] = ["maxConcurrentAgents"];

export type DayBucket = Partial<Record<StatCounter | StatGauge, number>>;

export interface PersistedStats {
  version: 1;
  /** Key: local YYYY-MM-DD. */
  days: Record<string, DayBucket>;
  /** badgeId -> ISO awarded-at. */
  badges: Record<string, string>;
}

export interface StatsSummary {
  today: DayBucket;
  last7Days: DayBucket;
  allTime: DayBucket;
  streakDays: number;
  badges: Record<string, string>;
  enabled: boolean;
}

/** Hard cap on retained day buckets. ~200 bytes/day keeps this under 100 KB. */
const MAX_DAYS = 400;
/** Days in the rolling window reported as `last7Days` (today + previous 6). */
const WINDOW_DAYS = 7;

const COUNTER_KEYS = new Set<string>(STAT_COUNTERS);
const GAUGE_KEYS = new Set<string>(STAT_GAUGES);

export class StatsStore {
  private dataDir: string;
  private days: Record<string, DayBucket>;
  private badges: Record<string, string>;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private isEnabled: () => boolean;
  private now: () => number;
  private monoNow: () => number;
  /** Per-session block bookkeeping for `observeHookEvent`. */
  private tracker: SignalTrackerState = createSignalTracker();

  constructor(
    dataDir?: string,
    opts?: {
      isEnabled?: () => boolean;
      now?: () => number;
      /**
       * Monotonic ms, used only for unblock latency. Inlined rather than
       * imported from `hook-relay` to keep this module off that import cycle.
       */
      monoNow?: () => number;
    },
  ) {
    this.dataDir = dataDir ?? manorDataDir();
    this.isEnabled = opts?.isEnabled ?? (() => true);
    this.now = opts?.now ?? (() => Date.now());
    this.monoNow =
      opts?.monoNow ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
    const state = this.loadState();
    this.days = state.days;
    this.badges = state.badges;
    this.prune();
  }

  private statsFilePath(): string {
    return path.join(this.dataDir, "stats.json");
  }

  private loadState(): { days: Record<string, DayBucket>; badges: Record<string, string> } {
    try {
      const data = fs.readFileSync(this.statsFilePath(), "utf-8");
      const state: Partial<PersistedStats> = JSON.parse(data);
      return {
        days: sanitizeDays(state.days),
        badges: sanitizeBadges(state.badges),
      };
    } catch {
      return { days: {}, badges: {} };
    }
  }

  private writeStateSync(): void {
    this.prune();
    const state: PersistedStats = {
      version: 1,
      days: this.days,
      badges: this.badges,
    };
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.statsFilePath(), JSON.stringify(state, null, 2));
  }

  private saveState(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeStateSync();
    }, 500);
  }

  /**
   * Writes the current state to disk synchronously, cancelling any pending
   * debounced save.
   */
  flushNow(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.writeStateSync();
  }

  /** Truncates to the newest `MAX_DAYS` buckets. Day keys sort lexicographically. */
  private prune(): void {
    const keys = Object.keys(this.days);
    if (keys.length <= MAX_DAYS) return;
    const keep = new Set(keys.sort().slice(keys.length - MAX_DAYS));
    const pruned: Record<string, DayBucket> = {};
    for (const key of keys) {
      if (keep.has(key)) pruned[key] = this.days[key];
    }
    this.days = pruned;
  }

  /** Notifies subscribers. Never lets a listener throw into a caller. */
  private emitChange(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // a broken subscriber must not break recording
      }
    }
  }

  /**
   * Subscribe to every mutation (record, recordMax, awardBadge, reset).
   * Returns an unsubscribe function.
   */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private todayKey(): string {
    return dayKey(this.now());
  }

  private currentBucket(): DayBucket {
    const key = this.todayKey();
    let bucket = this.days[key];
    if (!bucket) {
      bucket = {};
      this.days[key] = bucket;
    }
    return bucket;
  }

  /** Mutates today's bucket without saving or notifying. */
  private applyDelta(delta: StatDelta): void {
    const bucket = this.currentBucket();
    if ("counter" in delta) {
      bucket[delta.counter] = (bucket[delta.counter] ?? 0) + delta.n;
      return;
    }
    const previous = bucket[delta.gauge];
    if (previous === undefined || delta.value > previous) {
      bucket[delta.gauge] = delta.value;
    }
  }

  /**
   * Single commit step for every mutation path: one debounced save and one
   * change emission, however many deltas were applied. A burst of tool calls
   * must not turn into a burst of writes and broadcasts.
   */
  private commit(): void {
    this.saveState();
    this.emitChange();
  }

  /** Adds `n` to today's bucket. No-op when collection is disabled. */
  record(counter: StatCounter, n = 1): void {
    if (!this.isEnabled()) return;
    this.applyDelta({ counter, n });
    this.commit();
  }

  /** Keeps the max of `value` and today's recorded value for `gauge`. */
  recordMax(gauge: StatGauge, value: number): void {
    if (!this.isEnabled()) return;
    this.applyDelta({ gauge, value });
    this.commit();
  }

  /**
   * The hook-relay tap (ADR-168 §2). Turns one hook event and the effects the
   * relay derived from it into counter deltas, applying all of them under a
   * single commit.
   *
   * `activeAgentCount` is sampled by the caller (`agentManager.getActiveAgents()`)
   * because this store must not reach into agent persistence.
   */
  observeHookEvent(
    event: AgentHookEvent,
    effects: readonly Effect[],
    activeAgentCount: number,
  ): void {
    if (!this.isEnabled()) return;
    const deltas = deltasForHookEvent(event, effects, this.tracker, {
      monoNow: this.monoNow(),
      activeAgentCount,
    });
    if (deltas.length === 0) return;
    for (const delta of deltas) this.applyDelta(delta);
    this.commit();
  }

  getSummary(): StatsSummary {
    const today = this.todayKey();
    return {
      today: { ...(this.days[today] ?? {}) },
      last7Days: aggregate(this.windowBuckets(WINDOW_DAYS)),
      allTime: aggregate(Object.values(this.days)),
      streakDays: this.streakDays(),
      badges: this.getBadges(),
      enabled: this.isEnabled(),
    };
  }

  /** Buckets for today and the previous `count - 1` local days. */
  private windowBuckets(count: number): DayBucket[] {
    const buckets: DayBucket[] = [];
    for (let i = 0; i < count; i++) {
      const bucket = this.days[dayKeyOffset(this.now(), -i)];
      if (bucket) buckets.push(bucket);
    }
    return buckets;
  }

  /**
   * Consecutive local days with at least one prompt, counting back from today —
   * or from yesterday when today has no prompts yet, so an unstarted day does
   * not read as a broken streak. Zero when neither day has prompts.
   */
  private streakDays(): number {
    const hasPrompts = (offset: number): boolean =>
      (this.days[dayKeyOffset(this.now(), offset)]?.prompts ?? 0) >= 1;

    let offset: number;
    if (hasPrompts(0)) offset = 0;
    else if (hasPrompts(-1)) offset = -1;
    else return 0;

    let streak = 0;
    while (hasPrompts(offset)) {
      streak++;
      offset--;
    }
    return streak;
  }

  getBadges(): Record<string, string> {
    return { ...this.badges };
  }

  /** Records a badge award. Returns false when it was already awarded. */
  awardBadge(id: string, at = new Date(this.now()).toISOString()): boolean {
    if (this.badges[id] !== undefined) return false;
    this.badges[id] = at;
    this.saveState();
    this.emitChange();
    return true;
  }

  /** Clears all collected stats in memory and removes the file from disk. */
  reset(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.days = {};
    this.badges = {};
    try {
      fs.rmSync(this.statsFilePath(), { force: true });
    } catch {
      // best effort: an unremovable file is not worth crashing over
    }
    this.emitChange();
  }
}

/** Local `YYYY-MM-DD` for an epoch-ms timestamp. */
function dayKey(ms: number): string {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Day key `offset` local days away from `ms` (negative offsets go back). */
function dayKeyOffset(ms: number, offset: number): string {
  const date = new Date(ms);
  date.setDate(date.getDate() + offset);
  return dayKey(date.getTime());
}

/** Sums counters and maxes gauges across buckets. */
function aggregate(buckets: DayBucket[]): DayBucket {
  const total: DayBucket = {};
  for (const bucket of buckets) {
    for (const counter of STAT_COUNTERS) {
      const value = bucket[counter];
      if (value === undefined) continue;
      total[counter] = (total[counter] ?? 0) + value;
    }
    for (const gauge of STAT_GAUGES) {
      const value = bucket[gauge];
      if (value === undefined) continue;
      const previous = total[gauge];
      if (previous === undefined || value > previous) total[gauge] = value;
    }
  }
  return total;
}

/**
 * Keeps only well-formed day keys holding known counter/gauge keys with finite
 * numbers. Unknown keys — counters retired by a later version, or junk — are
 * dropped rather than carried forward.
 */
function sanitizeDays(days: unknown): Record<string, DayBucket> {
  if (!days || typeof days !== "object") return {};
  const result: Record<string, DayBucket> = {};
  for (const [key, raw] of Object.entries(days as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    if (!raw || typeof raw !== "object") continue;
    const bucket: DayBucket = {};
    for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!COUNTER_KEYS.has(field) && !GAUGE_KEYS.has(field)) continue;
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      bucket[field as StatCounter | StatGauge] = value;
    }
    result[key] = bucket;
  }
  return result;
}

function sanitizeBadges(badges: unknown): Record<string, string> {
  if (!badges || typeof badges !== "object") return {};
  const result: Record<string, string> = {};
  for (const [id, at] of Object.entries(badges as Record<string, unknown>)) {
    if (typeof at === "string") result[id] = at;
  }
  return result;
}
