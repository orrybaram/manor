/**
 * Merged stats: the desktop's store sums each host server's last-read
 * history into every total and awards badges on the combined history.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import { StatsStore } from "../stats-store";
import type { PersistedStats } from "../stats-store";

function localMs(year: number, month: number, day: number, hour = 12): number {
  return new Date(year, month - 1, day, hour).getTime();
}

describe("StatsStore across hosts", () => {
  let tmpDir: string;
  const now = () => localMs(2026, 10, 30);

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-stats-hosts-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sums a host's counters into today, the window and all time, and maxes gauges", () => {
    const store = new StatsStore(tmpDir, { now });
    store.record("prompts", 3);
    store.recordMax("maxConcurrentAgents", 4);
    store.setHostHistory("box", {
      days: {
        "2026-10-30": { prompts: 2, maxConcurrentAgents: 6 },
        "2026-10-20": { prompts: 5, toolCalls: 7 },
      },
      badges: {},
    });

    const summary = store.getSummary();
    expect(summary.today).toEqual({ prompts: 5, maxConcurrentAgents: 6 });
    expect(summary.last7Days.prompts).toBe(5);
    expect(summary.allTime).toEqual({ prompts: 10, toolCalls: 7, maxConcurrentAgents: 6 });
    expect(summary.dailyPrompts).toEqual([
      { day: "2026-10-20", count: 5 },
      { day: "2026-10-30", count: 5 },
    ]);
  });

  it("keeps a streak alive with weeks only a host prompted in", () => {
    const store = new StatsStore(tmpDir, { now });
    store.record("prompts");
    // The week before: host only. Two weeks before: desktop gap, host again.
    store.setHostHistory("box", {
      days: { "2026-10-21": { prompts: 1 }, "2026-10-14": { prompts: 1 } },
      badges: {},
    });
    expect(store.getSummary().streakWeeks).toBe(3);
  });

  it("replaces a host's history rather than adding to it", () => {
    const store = new StatsStore(tmpDir, { now });
    store.setHostHistory("box", { days: { "2026-10-30": { prompts: 2 } }, badges: {} });
    store.setHostHistory("box", { days: { "2026-10-30": { prompts: 3 } }, badges: {} });
    expect(store.getSummary().today.prompts).toBe(3);
  });

  it("awards what a host's first history earns quietly, with the host's date", () => {
    const onBadge = vi.fn();
    const store = new StatsStore(tmpDir, { now, onBadge });
    store.setHostHistory("box", {
      days: { "2026-10-01": { agentsKilled: 1 } },
      badges: { "first-blood": "2026-10-01T09:00:00.000Z" },
    });
    expect(onBadge).not.toHaveBeenCalled();
    expect(store.getBadges()["first-blood"]).toBe("2026-10-01T09:00:00.000Z");
  });

  it("announces a badge a later read of the host makes the total reach", () => {
    const onBadge = vi.fn();
    const store = new StatsStore(tmpDir, { now, onBadge });
    store.record("agentsKilled", 20);
    store.setHostHistory("box", { days: { "2026-10-29": { agentsKilled: 4 } }, badges: {} });
    expect(store.getBadges().executioner).toBeUndefined();
    onBadge.mockClear();

    store.setHostHistory("box", {
      days: { "2026-10-29": { agentsKilled: 4 }, "2026-10-30": { agentsKilled: 1 } },
      // The host earned nothing itself: only the total reaches 25.
      badges: {},
    });
    expect(onBadge.mock.calls.map(([badge]) => badge.id)).toEqual(["executioner"]);
    expect(store.getBadges().executioner).toBe(new Date(now()).toISOString());
  });

  it("announces a desktop recording that the host's share pushes over", () => {
    const onBadge = vi.fn();
    const store = new StatsStore(tmpDir, { now, onBadge });
    store.setHostHistory("box", { days: { "2026-10-29": { agentsKilled: 24 } }, badges: {} });
    expect(onBadge.mock.calls.map(([badge]) => badge.id)).toEqual([]);
    store.record("agentsKilled");
    expect(onBadge.mock.calls.map(([badge]) => badge.id)).toEqual(["executioner"]);
  });

  it("keeps a host's share across a restart, and drops it on reset", () => {
    const store = new StatsStore(tmpDir, { now });
    store.setHostHistory("box", { days: { "2026-10-30": { prompts: 2 } }, badges: {} });
    store.flushNow();
    const file = JSON.parse(fs.readFileSync(path.join(tmpDir, "stats.json"), "utf-8")) as PersistedStats;
    expect(file.hosts?.box.days["2026-10-30"]).toEqual({ prompts: 2 });

    const reloaded = new StatsStore(tmpDir, { now });
    expect(reloaded.getSummary().today.prompts).toBe(2);
    reloaded.reset();
    expect(reloaded.getSummary().today.prompts).toBeUndefined();
  });

  it("hands out its own history only, never a host's", () => {
    const store = new StatsStore(tmpDir, { now });
    store.record("prompts");
    store.setHostHistory("box", { days: { "2026-10-30": { prompts: 9 } }, badges: {} });
    expect(store.getHistory().days).toEqual({ "2026-10-30": { prompts: 1 } });
  });

  it("drops malformed host history", () => {
    const store = new StatsStore(tmpDir, { now });
    store.setHostHistory("box", {
      days: { "not-a-day": { prompts: 1 }, "2026-10-30": { prompts: "lots", toolCalls: 2 } },
      badges: { bogus: 3 },
    } as never);
    expect(store.getSummary().today).toEqual({ toolCalls: 2 });
  });

  it("takes nothing while collection is off", () => {
    const store = new StatsStore(tmpDir, { now, isEnabled: () => false });
    store.setHostHistory("box", { days: { "2026-10-30": { prompts: 2 } }, badges: {} });
    expect(store.getSummary().today).toEqual({});
  });
});
