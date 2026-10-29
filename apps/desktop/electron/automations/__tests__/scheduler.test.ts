/**
 * `AutomationScheduler` against a fake clock.
 *
 * The rules worth pinning: an occurrence fires once, on time or as a catch-up
 * within the grace window; everything older folds into one `missed` run; a
 * run whose predecessor is still working is skipped; pausing never backfills;
 * and one automation throwing never stops the others.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { AutomationStore } from "../automation-store";
import {
  AutomationScheduler,
  type AutomationFireResult,
  type AutomationSchedulerDeps,
} from "../scheduler";
import { isValidCron, nextRuns } from "../cron";
import type { Automation, AutomationInput } from "../../../src/lib/automations";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function input(overrides: Partial<AutomationInput> = {}): AutomationInput {
  return {
    name: "Nightly triage",
    enabled: true,
    schedule: { cron: "0 9 * * *", timezone: "UTC" },
    projectId: "project-1",
    prompt: "Triage new issues",
    agentKind: "claude",
    workspace: { mode: "new" },
    ...overrides,
  };
}

describe("AutomationScheduler", () => {
  let tmpDir: string;
  let store: AutomationStore;
  let nowMs: number;
  let busy: Set<string>;
  let fire: Mock<AutomationSchedulerDeps["fire"]>;
  let scheduler: AutomationScheduler;
  let agentCounter: number;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-automation-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    store = new AutomationStore(tmpDir);
    nowMs = Date.parse("2026-10-29T08:00:00.000Z");
    busy = new Set();
    agentCounter = 0;
    fire = vi.fn<AutomationSchedulerDeps["fire"]>(async () => {
      agentCounter++;
      return { outcome: "started", agentId: `agent-${agentCounter}` };
    });
    scheduler = new AutomationScheduler({
      store,
      now: () => nowMs,
      fire,
      isAgentBusy: (run) => busy.has(run.agentId ?? ""),
    });
  });

  afterEach(() => {
    store.flushNow();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function create(overrides: Partial<AutomationInput> = {}): Automation {
    return store.create(input(overrides), nowMs);
  }

  it("fires on time with trigger schedule", async () => {
    const a = create();
    nowMs = Date.parse("2026-10-29T09:00:10.000Z");
    await scheduler.tick();

    expect(fire).toHaveBeenCalledTimes(1);
    const [run] = store.runs(a.id);
    expect(run).toMatchObject({
      outcome: "started",
      trigger: "schedule",
      scheduledFor: "2026-10-29T09:00:00.000Z",
      agentId: "agent-1",
    });
    expect(store.get(a.id)?.lastScheduledFor).toBe("2026-10-29T09:00:00.000Z");
    expect(store.get(a.id)?.nextRunAt).toBe("2026-10-30T09:00:00.000Z");

    // The same occurrence never fires twice.
    nowMs += MINUTE;
    await scheduler.tick();
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("does nothing before the occurrence is due", async () => {
    const a = create();
    nowMs = Date.parse("2026-10-29T08:59:59.000Z");
    await scheduler.tick();

    expect(fire).not.toHaveBeenCalled();
    expect(store.runs(a.id)).toEqual([]);
    expect(store.get(a.id)?.nextRunAt).toBe("2026-10-29T09:00:00.000Z");
  });

  it("never fires an occurrence from before the automation was created", async () => {
    nowMs = Date.parse("2026-10-29T09:30:00.000Z");
    const a = create();
    await scheduler.tick();
    expect(fire).not.toHaveBeenCalled();
    expect(store.runs(a.id)).toEqual([]);
  });

  it("catches up the latest occurrence within the grace window", async () => {
    const a = create();
    nowMs = Date.parse("2026-10-29T15:00:00.000Z"); // 6h late, grace is 12h
    await scheduler.tick();

    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire.mock.calls[0][1]).toEqual({
      trigger: "catch-up",
      scheduledFor: "2026-10-29T09:00:00.000Z",
    });
    expect(store.runs(a.id)).toHaveLength(1);
    expect(store.runs(a.id)[0]).toMatchObject({ outcome: "started", trigger: "catch-up" });
  });

  it("records an occurrence outside the grace window as one skipped run", async () => {
    const a = create({ missedGraceMinutes: 60 });
    nowMs = Date.parse("2026-10-29T11:00:00.000Z"); // 2h late
    await scheduler.tick();

    expect(fire).not.toHaveBeenCalled();
    const runs = store.runs(a.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      outcome: "skipped",
      reason: "missed",
      missedCount: 1,
      scheduledFor: "2026-10-29T09:00:00.000Z",
    });
    expect(store.get(a.id)?.lastScheduledFor).toBe("2026-10-29T09:00:00.000Z");
  });

  it("folds many missed hourly occurrences into one run and catches up the latest", async () => {
    const a = create({ schedule: { cron: "0 * * * *", timezone: "UTC" } });
    nowMs += 30 * 24 * HOUR + 5 * MINUTE; // a month asleep
    await scheduler.tick();

    expect(fire).toHaveBeenCalledTimes(1);
    const runs = store.runs(a.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ outcome: "started", trigger: "catch-up" });
    expect(runs[1]).toMatchObject({
      outcome: "skipped",
      reason: "missed",
      missedCount: 30 * 24 - 1,
      scheduledFor: "2026-10-29T09:00:00.000Z",
    });
  });

  it("stops counting missed occurrences at 10,000", async () => {
    const a = create({ schedule: { cron: "* * * * *", timezone: "UTC" } });
    nowMs += 365 * 24 * HOUR;
    await scheduler.tick();

    const missed = store.runs(a.id).find((r) => r.reason === "missed");
    expect(missed?.missedCount).toBe(9_999);
  });

  it("skips a run while the previous run's agent is still working", async () => {
    const a = create();
    nowMs = Date.parse("2026-10-29T09:00:05.000Z");
    await scheduler.tick();
    busy.add("agent-1");

    nowMs = Date.parse("2026-10-30T09:00:05.000Z");
    await scheduler.tick();

    expect(fire).toHaveBeenCalledTimes(1);
    expect(store.runs(a.id)[0]).toMatchObject({
      outcome: "skipped",
      reason: "still-working",
      scheduledFor: "2026-10-30T09:00:00.000Z",
    });

    // Once it's done, the next occurrence fires.
    busy.clear();
    nowMs = Date.parse("2026-10-31T09:00:05.000Z");
    await scheduler.tick();
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("never fires a paused automation, and resuming doesn't backfill", async () => {
    const a = create({ enabled: false });
    expect(a.nextRunAt).toBeNull();

    nowMs = Date.parse("2026-10-29T09:00:05.000Z");
    await scheduler.tick();
    expect(fire).not.toHaveBeenCalled();
    expect(store.get(a.id)?.nextRunAt).toBeNull();

    nowMs = Date.parse("2026-10-29T10:00:00.000Z");
    store.update(a.id, { enabled: true }, nowMs);
    expect(store.get(a.id)?.nextRunAt).toBe("2026-10-30T09:00:00.000Z");
    await scheduler.tick();

    expect(fire).not.toHaveBeenCalled();
    expect(store.runs(a.id)).toEqual([]);
  });

  it("records a throwing fire as failed and still fires the other automations", async () => {
    const bad = create({ name: "Bad" });
    const good = create({ name: "Good" });
    fire.mockImplementation(async (automation: Automation) => {
      if (automation.id === bad.id) throw new Error("workspace exploded");
      return { outcome: "started", agentId: "agent-good" };
    });

    nowMs = Date.parse("2026-10-29T09:00:05.000Z");
    await scheduler.tick();

    expect(store.runs(bad.id)[0]).toMatchObject({
      outcome: "failed",
      reason: "error",
      detail: "workspace exploded",
    });
    expect(store.runs(good.id)[0]).toMatchObject({ outcome: "started", agentId: "agent-good" });
    // The failed occurrence is handled, not retried.
    expect(store.get(bad.id)?.lastScheduledFor).toBe("2026-10-29T09:00:00.000Z");
  });

  it("records what fire reports, e.g. a project that went missing", async () => {
    const a = create();
    fire.mockResolvedValue({
      outcome: "skipped",
      reason: "project-missing",
      detail: "Project missing on this host",
    });
    nowMs = Date.parse("2026-10-29T09:00:05.000Z");
    await scheduler.tick();
    expect(store.runs(a.id)[0]).toMatchObject({ outcome: "skipped", reason: "project-missing" });
  });

  it("doesn't start a second tick while one is running", async () => {
    create();
    let release!: () => void;
    fire.mockImplementation(
      () =>
        new Promise<AutomationFireResult>((resolve) => {
          release = () => resolve({ outcome: "started", agentId: "agent-slow" });
        }),
    );
    nowMs = Date.parse("2026-10-29T09:00:05.000Z");
    const first = scheduler.tick();
    const second = scheduler.tick();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(fire).toHaveBeenCalledTimes(1));
    release();
    await first;
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("runNow fires as manual, even paused or overlapping, without moving the schedule", async () => {
    const a = create({ enabled: false });
    busy.add("agent-1");
    nowMs = Date.parse("2026-10-29T08:30:00.000Z");

    const first = await scheduler.runNow(a.id);
    const second = await scheduler.runNow(a.id);

    expect(first).toMatchObject({
      trigger: "manual",
      outcome: "started",
      scheduledFor: "2026-10-29T08:30:00.000Z",
    });
    expect(second.agentId).toBe("agent-2");
    expect(store.get(a.id)?.lastScheduledFor).toBe(a.lastScheduledFor);
    expect(store.runs(a.id).map((r) => r.id)).toEqual([second.id, first.id]);
  });

  it("refresh recomputes nextRunAt from now", () => {
    const a = create();
    nowMs = Date.parse("2026-10-30T12:00:00.000Z");
    scheduler.refresh(a.id);
    expect(store.get(a.id)?.nextRunAt).toBe("2026-10-31T09:00:00.000Z");
  });

  it("start ticks at once and then every tickMs; stop clears the interval", async () => {
    let intervalFn: (() => void) | null = null;
    const clear = vi.fn();
    const timed = new AutomationScheduler({
      store,
      now: () => nowMs,
      fire,
      isAgentBusy: () => false,
      tickMs: 1_000,
      setInterval: (fn, ms) => {
        expect(ms).toBe(1_000);
        intervalFn = fn;
        return "handle";
      },
      clearInterval: clear,
    });
    create();
    nowMs = Date.parse("2026-10-29T09:00:00.500Z");
    timed.start();
    expect(fire).toHaveBeenCalledTimes(1);
    await timed.tick(); // the tick start() began, still finishing

    nowMs = Date.parse("2026-10-30T09:00:00.500Z");
    intervalFn!();
    await vi.waitFor(() => expect(fire).toHaveBeenCalledTimes(2));

    timed.stop();
    expect(clear).toHaveBeenCalledWith("handle");
  });

  it("reads the cron in the automation's timezone, across DST", async () => {
    // Weekdays at 09:00 New York: 13:00 UTC in summer time (EDT), 14:00 in winter (EST).
    const schedule = { cron: "0 9 * * 1-5", timezone: "America/New_York" };
    nowMs = Date.parse("2026-10-30T00:00:00.000Z"); // Friday
    const a = create({ schedule });

    nowMs = Date.parse("2026-10-30T13:00:05.000Z");
    await scheduler.tick();
    expect(store.runs(a.id)[0]?.scheduledFor).toBe("2026-10-30T13:00:00.000Z");
    // Clocks fall back on Sunday 1 November; the weekend is skipped.
    expect(store.get(a.id)?.nextRunAt).toBe("2026-11-02T14:00:00.000Z");

    nowMs = Date.parse("2026-11-02T13:00:05.000Z");
    await scheduler.tick();
    expect(fire).toHaveBeenCalledTimes(1);

    nowMs = Date.parse("2026-11-02T14:00:05.000Z");
    await scheduler.tick();
    expect(fire).toHaveBeenCalledTimes(2);
    expect(store.runs(a.id)[0]?.scheduledFor).toBe("2026-11-02T14:00:00.000Z");
  });
});

describe("cron helpers", () => {
  it("isValidCron accepts 5-field patterns in a real timezone only", () => {
    expect(isValidCron("0 9 * * 1-5", "Europe/London")).toBe(true);
    expect(isValidCron("0 0 9 * * 1-5", "Europe/London")).toBe(false);
    expect(isValidCron("61 * * * *", "Europe/London")).toBe(false);
    expect(isValidCron("0 9 * * *", "Nope/Zone")).toBe(false);
  });

  it("nextRuns lists the next occurrences after a time", () => {
    const runs = nextRuns(
      { cron: "30 14 * * *", timezone: "Europe/London" },
      Date.parse("2026-10-24T00:00:00.000Z"),
      3,
    );
    // British Summer Time ends on 25 October.
    expect(runs.map((d) => d.toISOString())).toEqual([
      "2026-10-24T13:30:00.000Z",
      "2026-10-25T14:30:00.000Z",
      "2026-10-26T14:30:00.000Z",
    ]);
  });
});
