import fs from "node:fs";
import path from "node:path";

import type { InboxKind, InboxSourceId, InboxSourceStatus, InboxStatus } from "../../src/lib/inbox";

/**
 * InboxPoller — checks each **Inbox** on its own timer and delivers what's new.
 *
 * A source's first successful check only records what is already there, so a
 * first run never floods the bell. After that every item of an offered type is
 * recorded as seen whether or not it was delivered: an item outside the user's
 * projects, or of a type switched off, never turns up late. Seen items survive a
 * relaunch, and each later check asks only for what changed since the last.
 *
 * Failures back off and show in `status()`; they never notify.
 */

/** One unread entry in a source's inbox. */
export interface InboxItem {
  /** Identifies this notification, so it's delivered once. */
  key: string;
  /** Null: a type Manor doesn't offer. */
  kind: InboxKind | null;
  /** Whether it belongs to a Manor project. */
  inScope: boolean;
  title: string;
  body: string;
  url: string | null;
}

export type InboxFetch =
  | { status: "not-modified"; nextDelayMs?: number }
  | {
      status: "ok";
      items: InboxItem[];
      cursor?: string;
      nextDelayMs?: number;
      /**
       * Scope isn't fully known, so an item out of scope may only look it: leave
       * those unseen and ask from the same point next time.
       */
      hold?: boolean;
    };

export interface InboxSource {
  id: InboxSourceId;
  /** Whether the source has what it needs to sign in. */
  isReady(): Promise<boolean>;
  account?(): Promise<string | null>;
  /** The repos or teams linked to projects. */
  coverage(): Promise<number>;
  /**
   * Items changed since `since`, or everything unread when it's absent (a
   * first check). `cursor` is what the last check returned.
   */
  fetch(since: string | undefined, cursor: string | undefined): Promise<InboxFetch>;
  /** Milliseconds between checks. */
  intervalMs: number;
}

export interface InboxPollerDeps {
  sources: InboxSource[];
  isEnabled(kind: InboxKind): boolean;
  deliver(item: InboxItem & { kind: InboxKind }, opts: { banner: boolean }): void;
  dataDir: string;
  now?: () => number;
  /** Overrides each source's interval. */
  intervalMs?: number;
  log?: (message: string) => void;
}

/** Most banners from one check; the rest only reach the bell. */
export const MAX_BANNERS_PER_CHECK = 5;
/** The longest wait after repeated failures. */
export const MAX_BACKOFF_MS = 15 * 60_000;
/**
 * How far before the last check to ask from, so a clock behind the service's
 * can't lose an item. Seen keys stop the overlap repeating anything.
 */
export const SINCE_OVERLAP_MS = 10 * 60_000;
/** How many seen keys one source keeps. */
export const MAX_SEEN = 5000;

interface SourceState {
  /** ISO time of the last successful check. Absent: never checked. */
  since?: string;
  cursor?: string;
  /** Oldest first. */
  seen: string[];
}

type PersistedState = Partial<Record<InboxSourceId, SourceState>>;

export class InboxPoller {
  private state: PersistedState;
  private statuses: InboxStatus = {
    github: { state: "starting" },
    linear: { state: "starting" },
  };
  private timers = new Map<InboxSourceId, ReturnType<typeof setTimeout>>();
  private failures = new Map<InboxSourceId, number>();
  private running = false;
  private stopped = false;
  private inFlight = new Set<Promise<void>>();

  constructor(private readonly deps: InboxPollerDeps) {
    this.state = this.load();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const source of this.deps.sources) this.track(source);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled(this.inFlight);
  }

  status(): InboxStatus {
    return { ...this.statuses };
  }

  /** One check of one source, then the next is scheduled. */
  async check(source: InboxSource): Promise<void> {
    let delay = this.deps.intervalMs ?? source.intervalMs;
    const prior = this.statuses[source.id];
    const startedAt = new Date(this.now()).toISOString();
    try {
      if (!(await source.isReady())) {
        this.statuses[source.id] = { state: "signed-out" };
      } else {
        const state = this.state[source.id] ?? { seen: [] };
        const baseline = state.since === undefined;
        const since =
          state.since === undefined
            ? undefined
            : new Date(Date.parse(state.since) - SINCE_OVERLAP_MS).toISOString();
        const result = await source.fetch(since, state.cursor);
        // Stopping: the log has had its last save, so leave this for next launch.
        if (this.stopped) return;
        if (result.nextDelayMs !== undefined && this.deps.intervalMs === undefined) {
          delay = result.nextDelayMs;
        }
        // A 304 moves neither point: an item it hid (HTTP dates only go to the
        // second) must still be in the window when the next 200 comes.
        if (result.status === "ok") {
          const hold = !baseline && result.hold === true;
          this.process(source.id, state, result.items, baseline, hold);
          if (!hold) {
            if (result.cursor !== undefined) state.cursor = result.cursor;
            state.since = startedAt;
          }
        }
        this.state[source.id] = state;
        this.save();
        this.failures.delete(source.id);
        this.statuses[source.id] = {
          state: "ok",
          account: (await source.account?.()) ?? null,
          covered: await source.coverage(),
          checkedAt: startedAt,
        };
      }
    } catch (err) {
      const failures = (this.failures.get(source.id) ?? 0) + 1;
      this.failures.set(source.id, failures);
      delay = Math.min(delay * 2 ** failures, MAX_BACKOFF_MS);
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log?.(`${source.id}: ${message}`);
      this.statuses[source.id] = {
        state: "error",
        message,
        checkedAt: lastChecked(prior),
      };
    }
    if (this.running) {
      this.timers.set(source.id, setTimeout(() => this.track(source), delay));
    }
  }

  private track(source: InboxSource): void {
    const run = this.check(source).finally(() => this.inFlight.delete(run));
    this.inFlight.add(run);
  }

  private process(
    id: InboxSourceId,
    state: SourceState,
    items: InboxItem[],
    baseline: boolean,
    hold: boolean,
  ): void {
    const seen = new Set(state.seen);
    let banners = 0;
    for (const item of items) {
      // Never deliverable, so not worth a place in the list.
      if (item.kind === null || seen.has(item.key)) continue;
      if (hold && !item.inScope) continue;
      seen.add(item.key);
      state.seen.push(item.key);
      if (baseline || !item.inScope) continue;
      if (!this.deps.isEnabled(item.kind)) continue;
      const banner = banners < MAX_BANNERS_PER_CHECK;
      if (banner) banners += 1;
      try {
        this.deps.deliver({ ...item, kind: item.kind }, { banner });
      } catch (err) {
        // One bad delivery mustn't lose the rest of the check.
        this.deps.log?.(`${id}: could not deliver: ${String(err)}`);
      }
    }
    if (state.seen.length > MAX_SEEN) state.seen = state.seen.slice(-MAX_SEEN);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private file(): string {
    return path.join(this.deps.dataDir, "inbox-notifications.json");
  }

  private load(): PersistedState {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file(), "utf-8"));
      if (!parsed || typeof parsed !== "object") return {};
      const out: PersistedState = {};
      for (const id of ["github", "linear"] as const) {
        const raw = (parsed as PersistedState)[id];
        if (!raw || !Array.isArray(raw.seen)) continue;
        out[id] = {
          seen: raw.seen.filter((key) => typeof key === "string"),
          ...(typeof raw.since === "string" ? { since: raw.since } : {}),
          ...(typeof raw.cursor === "string" ? { cursor: raw.cursor } : {}),
        };
      }
      return out;
    } catch {
      return {};
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(this.deps.dataDir, { recursive: true });
      const temp = `${this.file()}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(this.state));
      fs.renameSync(temp, this.file());
    } catch (err) {
      this.deps.log?.(`could not save: ${String(err)}`);
    }
  }
}

function lastChecked(status: InboxSourceStatus): string | null {
  return status.state === "ok" || status.state === "error" ? status.checkedAt : null;
}
