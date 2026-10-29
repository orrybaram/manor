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
 * - The latest one fires if it is within the automation's grace window:
 *   as `schedule` when it's on time (within two ticks), else as `catch-up`.
 *   A latest one outside the window is missed.
 * - Every earlier occurrence, and a missed latest one, folds into ONE
 *   skipped run (`missed`, with `missedCount`), so a laptop asleep for a
 *   week records one line, not 168.
 * - Before firing, if the last started run's agent is still busy, the run is
 *   skipped as `still-working` instead.
 *
 * `lastScheduledFor` moves past an occurrence *before* it fires, so a crash
 * mid-fire never fires it twice. One automation's failure never stops the
 * tick for the others, and a tick still running when the next interval hits
 * is not started again.
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
  /** Whether the agent is still thinking or working. */
  isAgentBusy: (agentId: string) => boolean;
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
  private inFlight: Promise<void> | null = null;

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

  stop(): void {
    if (this.timer === null) return;
    const clearIntervalFn =
      this.deps.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
    clearIntervalFn(this.timer);
    this.timer = null;
  }

  /**
   * Handles every automation once. A call while a tick is running returns
   * that tick rather than starting another.
   */
  tick(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runTick().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runTick(): Promise<void> {
    const ids = this.deps.store.list().map((a) => a.id);
    for (const id of ids) {
      try {
        await this.tickOne(id);
      } catch (err) {
        this.deps.log?.(`automation ${id}: tick failed: ${errorMessage(err)}`);
      }
    }
  }

  private async tickOne(id: string): Promise<void> {
    const { store } = this.deps;
    // Re-read: an earlier automation's fire may have taken a while.
    const automation = store.get(id);
    if (!automation) return;
    if (!automation.enabled) {
      store.setScheduled(id, automation.lastScheduledFor, null);
      return;
    }
    const now = this.deps.now();
    const occurrences = occurrencesBetween(
      automation.schedule,
      Date.parse(automation.lastScheduledFor),
      now,
    );
    if (!occurrences) {
      store.setScheduled(id, automation.lastScheduledFor, nextRunAfter(automation.schedule, now));
      return;
    }

    const { earliestMs, latestMs, count } = occurrences;
    const lateMs = now - latestMs;
    const firesLatest = lateMs <= automation.missedGraceMinutes * 60_000;
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
    if (!firesLatest) return;

    const trigger: AutomationRunTrigger = lateMs <= 2 * this.tickMs ? "schedule" : "catch-up";
    const previous = store.lastStartedRun(id);
    if (previous?.agentId && this.deps.isAgentBusy(previous.agentId)) {
      store.appendRun({
        automationId: id,
        scheduledFor: latest,
        firedAt,
        trigger,
        outcome: "skipped",
        reason: "still-working",
        detail: "The previous run is still working",
        agentId: previous.agentId,
      });
      return;
    }
    await this.fireAndRecord(automation, trigger, latest, firedAt);
  }

  /**
   * Fires now as `manual`, whether or not the automation is enabled or its
   * previous run is still working. Leaves `lastScheduledFor` alone, so the
   * schedule carries on as before. Throws for an unknown id.
   */
  async runNow(id: string): Promise<AutomationRun> {
    const automation = this.deps.store.get(id);
    if (!automation) throw new Error(`No automation ${id}`);
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

  private async fireAndRecord(
    automation: Automation,
    trigger: AutomationRunTrigger,
    scheduledFor: string,
    firedAt: string,
  ): Promise<AutomationRun> {
    const base = { automationId: automation.id, scheduledFor, firedAt, trigger };
    try {
      const result = await this.deps.fire(automation, { trigger, scheduledFor });
      return this.deps.store.appendRun({ ...result, ...base });
    } catch (err) {
      const detail = errorMessage(err);
      this.deps.log?.(`automation ${automation.id}: fire failed: ${detail}`);
      return this.deps.store.appendRun({ ...base, outcome: "failed", reason: "error", detail });
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
