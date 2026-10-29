import type {
  Automation,
  AutomationRun,
  AutomationRunTrigger,
} from "../../src/lib/automations";
import type { AutomationStore } from "./automation-store";
import { nextRunAfter, occurrencesBetween } from "./cron";

/**
 * AutomationScheduler — decides when each automation fires.
 *
 * Every `tickMs` it looks at each enabled automation's occurrences since
 * `lastScheduledFor`:
 *
 * - The latest one fires as `schedule` when it's on time (within two
 *   ticks), else as `catch-up` if it is within the automation's grace
 *   window. A latest one outside both is missed; a grace of 0 turns off
 *   catch-up, never an on-time run.
 * - Every earlier occurrence, and a missed latest one, folds into ONE
 *   skipped run (`missed`, with `missedCount`), so a laptop asleep for a
 *   week records one line, not 168.
 * - Before firing, if the automation is still being fired or the last started
 *   run's agent is still busy, the run is skipped as `still-working` instead.
 *
 * A tick decides every automation against one `now` first, and writes
 * `lastScheduledFor` to disk *before* any fire starts, so a crash mid-fire
 * never fires an occurrence twice. Then the fires run concurrently: a slow
 * one (a worktree, say) never makes the others late, and never blocks the
 * next tick from deciding them. One automation's failure never stops the
 * others. A `lastScheduledFor` in the future (the clock went back) is pulled
 * back to now rather than stalling the automation until the clock catches up.
 *
 * While `blocked()` names a reason (a host server not yet adopted, or whose
 * daemon has not connected), a tick decides nothing and writes nothing: the
 * occurrences wait, and once unblocked the usual on-time, grace and missed
 * rules apply to them.
 *
 * `stop()` ends the ticks and resolves once the fires still in flight
 * (Run now's included) have recorded their runs, so a shutdown can wait for
 * them before its last save.
 *
 * Firing itself (workspace, agent) is the injected `fire`; the clock and the
 * timer are injected too, so tests drive it with a fake clock.
 */

/** What `fire` reports; the scheduler fills in the rest of the run. */
export type AutomationFireResult = Omit<
  AutomationRun,
  "id" | "automationId" | "scheduledFor" | "firedAt" | "trigger"
>;

export interface AutomationSchedulerDeps {
  store: AutomationStore;
  now: () => number;
  fire: (
    automation: Automation,
    ctx: { trigger: AutomationRunTrigger; scheduledFor: string },
  ) => Promise<AutomationFireResult>;
  /** Whether a started run's agent is still thinking or working. */
  isAgentBusy: (run: AutomationRun) => boolean;
  /**
   * Why nothing may fire now, or null when it may. While blocked, ticks
   * leave every automation as it is and Run now throws with this reason.
   */
  blocked?: () => string | null;
  log?: (message: string) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Defaults to 30s. */
  tickMs?: number;
}

const DEFAULT_TICK_MS = 30_000;

export class AutomationScheduler {
  private deps: AutomationSchedulerDeps;
  private tickMs: number;
  private timer: unknown = null;
  /** automationId → how many of its fires are still running. */
  private firing = new Map<string, number>();
  /** Every fire still running, for `stop()` to wait on. */
  private inFlight = new Set<Promise<unknown>>();
  /** The last blocked reason logged, so a long block logs once. */
  private loggedBlock: string | null = null;

  constructor(deps: AutomationSchedulerDeps) {
    this.deps = deps;
    this.tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  }

  /** Ticks now, then every `tickMs`. */
  start(): void {
    if (this.timer !== null) return;
    void this.tick();
    const setIntervalFn = this.deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.timer = setIntervalFn(() => void this.tick(), this.tickMs);
  }

  /**
   * Ends the ticks. Resolves once every fire in flight now has settled and
   * recorded its run; never rejects.
   */
  stop(): Promise<void> {
    if (this.timer !== null) {
      const clearIntervalFn =
        this.deps.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
      clearIntervalFn(this.timer);
      this.timer = null;
    }
    return Promise.allSettled([...this.inFlight]).then(() => undefined);
  }

  /**
   * Decides every automation against one `now`, then fires the due ones
   * concurrently. Resolves once this tick's fires have settled.
   */
  async tick(): Promise<void> {
    // Checked before anything is decided: a blocked tick must not consume
    // occurrences or write a run.
    const blocked = this.deps.blocked?.() ?? null;
    if (blocked) {
      if (this.loggedBlock !== blocked) this.deps.log?.(`not firing: ${blocked}`);
      this.loggedBlock = blocked;
      return;
    }
    this.loggedBlock = null;
    const now = this.deps.now();
    const fires: Array<() => Promise<unknown>> = [];
    for (const automation of this.deps.store.list()) {
      try {
        const fire = this.decide(automation, now);
        if (fire) fires.push(fire);
      } catch (err) {
        this.deps.log?.(`automation ${automation.id}: tick failed: ${errorMessage(err)}`);
      }
    }
    if (fires.length === 0) return;
    // Every fired occurrence is past `lastScheduledFor` on disk before its
    // fire starts, so a crash mid-fire can't fire it again on restart.
    try {
      this.deps.store.flushNow();
    } catch (err) {
      this.deps.log?.(`saving the schedule failed: ${errorMessage(err)}`);
    }
    await Promise.allSettled(fires.map((fire) => fire()));
  }

  /**
   * Records this tick's outcome for one automation and returns its fire,
   * or null when nothing fires.
   */
  private decide(automation: Automation, now: number): (() => Promise<unknown>) | null {
    const { store } = this.deps;
    const id = automation.id;
    if (!automation.enabled) {
      store.setScheduled(id, automation.lastScheduledFor, null);
      return null;
    }
    const lastMs = Date.parse(automation.lastScheduledFor);
    if (lastMs > now + this.tickMs) {
      this.deps.log?.(
        `automation ${id}: last scheduled for ${automation.lastScheduledFor}, after now; the clock went back, restarting the schedule from now`,
      );
      store.setScheduled(id, new Date(now).toISOString(), nextRunAfter(automation.schedule, now));
      return null;
    }
    const occurrences = occurrencesBetween(automation.schedule, lastMs, now);
    if (!occurrences) {
      store.setScheduled(id, automation.lastScheduledFor, nextRunAfter(automation.schedule, now));
      return null;
    }

    const { earliestMs, latestMs, count } = occurrences;
    const lateMs = now - latestMs;
    const onTimeMs = 2 * this.tickMs;
    const firesLatest = lateMs <= Math.max(onTimeMs, automation.missedGraceMinutes * 60_000);
    const missedCount = firesLatest ? count - 1 : count;
    const firedAt = new Date(now).toISOString();
    const latest = new Date(latestMs).toISOString();

    store.setScheduled(id, latest, nextRunAfter(automation.schedule, now));

    if (missedCount > 0) {
      store.appendRun({
        automationId: id,
        scheduledFor: new Date(earliestMs).toISOString(),
        firedAt,
        trigger: "schedule",
        outcome: "skipped",
        reason: "missed",
        missedCount,
        detail:
          missedCount === 1
            ? "Missed 1 scheduled run"
            : `Missed ${missedCount} scheduled runs`,
      });
    }
    if (!firesLatest) return null;

    const trigger: AutomationRunTrigger = lateMs <= onTimeMs ? "schedule" : "catch-up";
    const stillWorking = {
      automationId: id,
      scheduledFor: latest,
      firedAt,
      trigger,
      outcome: "skipped",
      reason: "still-working",
      detail: "The previous run is still working",
    } as const;
    if (this.firing.has(id)) {
      store.appendRun(stillWorking);
      return null;
    }
    const previous = store.lastStartedRun(id);
    if (previous && this.deps.isAgentBusy(previous)) {
      store.appendRun({
        ...stillWorking,
        ...(previous.agentId ? { agentId: previous.agentId } : {}),
        ...(previous.paneId ? { paneId: previous.paneId } : {}),
      });
      return null;
    }
    return () => this.fireAndRecord(automation, trigger, latest, firedAt);
  }

  /**
   * Fires now as `manual`, whether or not the automation is enabled or its
   * previous run is still working. Leaves `lastScheduledFor` alone, so the
   * schedule carries on as before. Throws for an unknown id, and with the
   * reason while the scheduler is blocked.
   */
  async runNow(id: string): Promise<AutomationRun> {
    const automation = this.deps.store.get(id);
    if (!automation) throw new Error(`No automation ${id}`);
    const blocked = this.deps.blocked?.() ?? null;
    if (blocked) throw new Error(blocked);
    const iso = new Date(this.deps.now()).toISOString();
    return this.fireAndRecord(automation, "manual", iso, iso);
  }

  /** Recomputes `nextRunAt` from now, e.g. after a create or an update. */
  refresh(id: string): void {
    const automation = this.deps.store.get(id);
    if (!automation) return;
    const nextRunAt = automation.enabled
      ? nextRunAfter(automation.schedule, this.deps.now())
      : null;
    this.deps.store.setScheduled(id, automation.lastScheduledFor, nextRunAt);
  }

  private fireAndRecord(
    automation: Automation,
    trigger: AutomationRunTrigger,
    scheduledFor: string,
    firedAt: string,
  ): Promise<AutomationRun> {
    const fired = this.fireAndRecordNow(automation, trigger, scheduledFor, firedAt);
    this.inFlight.add(fired);
    void fired.finally(() => this.inFlight.delete(fired)).catch(() => {});
    return fired;
  }

  private async fireAndRecordNow(
    automation: Automation,
    trigger: AutomationRunTrigger,
    scheduledFor: string,
    firedAt: string,
  ): Promise<AutomationRun> {
    const id = automation.id;
    const base = { automationId: id, scheduledFor, firedAt, trigger };
    this.firing.set(id, (this.firing.get(id) ?? 0) + 1);
    try {
      const result = await this.deps.fire(automation, { trigger, scheduledFor });
      return this.deps.store.appendRun({ ...result, ...base });
    } catch (err) {
      const detail = errorMessage(err);
      this.deps.log?.(`automation ${id}: fire failed: ${detail}`);
      return this.deps.store.appendRun({ ...base, outcome: "failed", reason: "error", detail });
    } finally {
      const left = (this.firing.get(id) ?? 1) - 1;
      if (left > 0) this.firing.set(id, left);
      else this.firing.delete(id);
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
