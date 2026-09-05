import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import { StatsStore } from "../stats-store";
import type { PersistedStats } from "../stats-store";
import type { AgentHookEvent } from "../agent-hook-events";
import type { Effect } from "../hook-relay-transition";

/** Local-time epoch ms, so day bucketing is exercised in the app's own timezone. */
function localMs(
  year: number,
  month: number,
  day: number,
  hour = 12,
  minute = 0,
): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

describe("StatsStore", () => {
  let tmpDir: string;
  let statsPath: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-stats-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    statsPath = path.join(tmpDir, "stats.json");
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readFile(): PersistedStats {
    return JSON.parse(fs.readFileSync(statsPath, "utf-8"));
  }

  describe("persistence", () => {
    it("round-trips counters and badges through disk", () => {
      const now = () => localMs(2026, 9, 5);
      const store = new StatsStore(tmpDir, { now });
      store.record("prompts", 3);
      store.record("agentsKilled");
      store.recordMax("maxConcurrentAgents", 4);
      store.awardBadge("first-blood", "2026-09-05T00:00:00.000Z");
      store.flushNow();

      const reloaded = new StatsStore(tmpDir, { now });
      const summary = reloaded.getSummary();
      expect(summary.today).toEqual({
        prompts: 3,
        agentsKilled: 1,
        maxConcurrentAgents: 4,
      });
      expect(summary.badges).toEqual({ "first-blood": "2026-09-05T00:00:00.000Z" });
    });

    it("writes version 1 with local day keys", () => {
      const store = new StatsStore(tmpDir, { now: () => localMs(2026, 9, 5, 23, 30) });
      store.record("prompts");
      store.flushNow();

      const state = readFile();
      expect(state.version).toBe(1);
      expect(Object.keys(state.days)).toEqual(["2026-09-05"]);
    });

    it("a missing stats.json yields an empty store", () => {
      const store = new StatsStore(tmpDir);
      expect(store.getSummary().allTime).toEqual({});
      expect(store.getSummary().badges).toEqual({});
    });

    it("a corrupt stats.json yields an empty store instead of throwing", () => {
      fs.writeFileSync(statsPath, "{ not valid json");

      expect(() => new StatsStore(tmpDir)).not.toThrow();
      expect(new StatsStore(tmpDir).getSummary().allTime).toEqual({});
    });

    it("drops unknown counter keys and non-numeric values from a loaded bucket", () => {
      fs.writeFileSync(
        statsPath,
        JSON.stringify({
          version: 1,
          days: {
            "2026-09-05": {
              prompts: 2,
              retiredCounter: 99,
              toolCalls: "many",
              maxConcurrentAgents: 3,
            },
            "not-a-day": { prompts: 5 },
          },
          badges: { "first-blood": "2026-09-05T00:00:00.000Z", bogus: 7 },
        }),
      );

      const store = new StatsStore(tmpDir, { now: () => localMs(2026, 9, 5) });
      expect(store.getSummary().today).toEqual({ prompts: 2, maxConcurrentAgents: 3 });
      expect(store.getSummary().allTime).toEqual({ prompts: 2, maxConcurrentAgents: 3 });
      expect(store.getBadges()).toEqual({ "first-blood": "2026-09-05T00:00:00.000Z" });
    });

    it("debounces the save by 500 ms, and flushNow writes immediately", () => {
      vi.useFakeTimers();
      const store = new StatsStore(tmpDir, { now: () => localMs(2026, 9, 5) });

      store.record("prompts");
      expect(fs.existsSync(statsPath)).toBe(false);

      vi.advanceTimersByTime(499);
      expect(fs.existsSync(statsPath)).toBe(false);

      vi.advanceTimersByTime(1);
      expect(readFile().days["2026-09-05"]).toEqual({ prompts: 1 });

      store.record("prompts");
      store.flushNow();
      expect(readFile().days["2026-09-05"]).toEqual({ prompts: 2 });

      // flushNow cancelled the pending timer, so nothing else fires later.
      const writes = vi.getTimerCount();
      expect(writes).toBe(0);
    });
  });

  describe("day bucketing", () => {
    it("splits records across a local midnight boundary", () => {
      let now = localMs(2026, 9, 5, 23, 59);
      const store = new StatsStore(tmpDir, { now: () => now });

      store.record("prompts", 2);
      now = localMs(2026, 9, 6, 0, 1);
      store.record("prompts", 5);
      store.flushNow();

      const state = readFile();
      expect(state.days["2026-09-05"]).toEqual({ prompts: 2 });
      expect(state.days["2026-09-06"]).toEqual({ prompts: 5 });
      expect(store.getSummary().today).toEqual({ prompts: 5 });
      expect(store.getSummary().allTime).toEqual({ prompts: 7 });
    });

    it("last7Days covers today and the previous six days only", () => {
      let now = localMs(2026, 9, 5);
      const store = new StatsStore(tmpDir, { now: () => now });

      // One prompt per day for 10 consecutive days, ending 2026-09-05.
      for (let dayOffset = 9; dayOffset >= 0; dayOffset--) {
        now = localMs(2026, 9, 5) - dayOffset * 86_400_000;
        store.record("prompts");
      }
      now = localMs(2026, 9, 5);

      const summary = store.getSummary();
      expect(summary.today).toEqual({ prompts: 1 });
      expect(summary.last7Days).toEqual({ prompts: 7 });
      expect(summary.allTime).toEqual({ prompts: 10 });
    });

    it("aggregates gauges with max and counters with sum", () => {
      let now = localMs(2026, 9, 4);
      const store = new StatsStore(tmpDir, { now: () => now });

      store.recordMax("maxConcurrentAgents", 6);
      store.record("toolCalls", 10);
      now = localMs(2026, 9, 5);
      store.recordMax("maxConcurrentAgents", 2);
      store.record("toolCalls", 4);

      const summary = store.getSummary();
      expect(summary.today).toEqual({ maxConcurrentAgents: 2, toolCalls: 4 });
      expect(summary.last7Days).toEqual({ maxConcurrentAgents: 6, toolCalls: 14 });
      expect(summary.allTime).toEqual({ maxConcurrentAgents: 6, toolCalls: 14 });
    });

    it("prunes to the newest 400 day buckets on load and on save", () => {
      const days: Record<string, { prompts: number }> = {};
      const base = localMs(2020, 1, 1);
      for (let i = 0; i < 405; i++) {
        const date = new Date(base + i * 86_400_000);
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        days[key] = { prompts: i };
      }
      fs.writeFileSync(statsPath, JSON.stringify({ version: 1, days, badges: {} }));

      const store = new StatsStore(tmpDir, { now: () => base });
      store.flushNow();

      const kept = Object.keys(readFile().days).sort();
      expect(kept.length).toBe(400);
      // The five oldest were dropped; the newest survived.
      expect(kept[0]).toBe("2020-01-06");
      expect(kept[399]).toBe("2021-02-08");
    });
  });

  describe("recordMax", () => {
    it("keeps the highest value seen for the day", () => {
      const store = new StatsStore(tmpDir, { now: () => localMs(2026, 9, 5) });
      store.recordMax("maxConcurrentAgents", 3);
      expect(store.getSummary().today.maxConcurrentAgents).toBe(3);

      store.recordMax("maxConcurrentAgents", 7);
      expect(store.getSummary().today.maxConcurrentAgents).toBe(7);

      store.recordMax("maxConcurrentAgents", 2);
      expect(store.getSummary().today.maxConcurrentAgents).toBe(7);
    });
  });

  describe("streakDays", () => {
    function storeWithPromptDays(offsets: number[], nowMs: number): StatsStore {
      const days: Record<string, { prompts: number }> = {};
      for (const offset of offsets) {
        const date = new Date(nowMs);
        date.setDate(date.getDate() + offset);
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        days[key] = { prompts: 1 };
      }
      fs.writeFileSync(statsPath, JSON.stringify({ version: 1, days, badges: {} }));
      return new StatsStore(tmpDir, { now: () => nowMs });
    }

    const now = localMs(2026, 9, 5);

    it("is zero for an empty store", () => {
      expect(new StatsStore(tmpDir, { now: () => now }).getSummary().streakDays).toBe(0);
    });

    it("counts back from today when today has prompts", () => {
      const store = storeWithPromptDays([0, -1, -2], now);
      expect(store.getSummary().streakDays).toBe(3);
    });

    it("counts back from yesterday when today has none yet", () => {
      const store = storeWithPromptDays([-1, -2], now);
      expect(store.getSummary().streakDays).toBe(2);
    });

    it("is zero when neither today nor yesterday has prompts", () => {
      const store = storeWithPromptDays([-2, -3, -4], now);
      expect(store.getSummary().streakDays).toBe(0);
    });

    it("stops at the first gap", () => {
      const store = storeWithPromptDays([0, -1, -3, -4], now);
      expect(store.getSummary().streakDays).toBe(2);
    });

    it("ignores days that only have non-prompt activity", () => {
      const store = new StatsStore(tmpDir, { now: () => now });
      store.record("toolCalls", 50);
      expect(store.getSummary().streakDays).toBe(0);
      store.record("prompts");
      expect(store.getSummary().streakDays).toBe(1);
    });
  });

  describe("kill switch", () => {
    it("record and recordMax are no-ops while disabled", () => {
      let enabled = false;
      const store = new StatsStore(tmpDir, {
        now: () => localMs(2026, 9, 5),
        isEnabled: () => enabled,
      });

      store.record("prompts", 5);
      store.recordMax("maxConcurrentAgents", 9);
      expect(store.getSummary().today).toEqual({});
      expect(store.getSummary().enabled).toBe(false);
      expect(fs.existsSync(statsPath)).toBe(false);

      enabled = true;
      store.record("prompts");
      expect(store.getSummary().today).toEqual({ prompts: 1 });
      expect(store.getSummary().enabled).toBe(true);
    });

    it("reset clears memory and deletes the file", () => {
      const store = new StatsStore(tmpDir, { now: () => localMs(2026, 9, 5) });
      store.record("prompts", 4);
      store.awardBadge("first-blood");
      store.flushNow();
      expect(fs.existsSync(statsPath)).toBe(true);

      store.reset();

      expect(fs.existsSync(statsPath)).toBe(false);
      const summary = store.getSummary();
      expect(summary.today).toEqual({});
      expect(summary.allTime).toEqual({});
      expect(summary.badges).toEqual({});
      expect(summary.streakDays).toBe(0);
    });

    it("reset cancels a pending debounced save so nothing is rewritten", () => {
      vi.useFakeTimers();
      const store = new StatsStore(tmpDir, { now: () => localMs(2026, 9, 5) });
      store.record("prompts");
      store.reset();

      vi.advanceTimersByTime(1000);
      expect(fs.existsSync(statsPath)).toBe(false);
    });

    it("reset on a store that never wrote a file does not throw", () => {
      const store = new StatsStore(tmpDir);
      expect(() => store.reset()).not.toThrow();
    });
  });

  describe("badges", () => {
    it("awardBadge is idempotent and keeps the first timestamp", () => {
      const store = new StatsStore(tmpDir, { now: () => localMs(2026, 9, 5) });

      expect(store.awardBadge("first-blood", "2026-09-05T10:00:00.000Z")).toBe(true);
      expect(store.awardBadge("first-blood", "2026-09-06T10:00:00.000Z")).toBe(false);
      expect(store.getBadges()).toEqual({ "first-blood": "2026-09-05T10:00:00.000Z" });
    });

    it("defaults the awarded-at to the injected clock", () => {
      const now = localMs(2026, 9, 5, 8, 30);
      const store = new StatsStore(tmpDir, { now: () => now });
      store.awardBadge("swarm");
      expect(store.getBadges().swarm).toBe(new Date(now).toISOString());
    });

    it("badges are recorded even while collection is disabled", () => {
      const store = new StatsStore(tmpDir, { isEnabled: () => false });
      expect(store.awardBadge("swarm")).toBe(true);
      expect(store.getBadges().swarm).toBeTruthy();
    });

    it("getBadges returns a copy the caller cannot mutate into the store", () => {
      const store = new StatsStore(tmpDir);
      store.awardBadge("swarm", "2026-09-05T10:00:00.000Z");
      const badges = store.getBadges();
      badges.injected = "nope";
      expect(store.getBadges()).toEqual({ swarm: "2026-09-05T10:00:00.000Z" });
    });
  });

  describe("onChange", () => {
    it("fires after every mutating call and stops after unsubscribe", () => {
      const store = new StatsStore(tmpDir, { now: () => localMs(2026, 9, 5) });
      const listener = vi.fn();
      const unsubscribe = store.onChange(listener);

      store.record("prompts");
      store.recordMax("maxConcurrentAgents", 2);
      store.awardBadge("first-blood");
      store.reset();
      expect(listener).toHaveBeenCalledTimes(4);

      unsubscribe();
      store.record("prompts");
      expect(listener).toHaveBeenCalledTimes(4);
    });

    it("does not fire for a no-op record while disabled or a duplicate badge", () => {
      const store = new StatsStore(tmpDir, {
        now: () => localMs(2026, 9, 5),
        isEnabled: () => false,
      });
      const listener = vi.fn();
      store.onChange(listener);

      store.record("prompts");
      store.recordMax("maxConcurrentAgents", 2);
      expect(listener).not.toHaveBeenCalled();

      store.awardBadge("first-blood");
      store.awardBadge("first-blood");
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("a throwing listener does not break recording", () => {
      const store = new StatsStore(tmpDir, { now: () => localMs(2026, 9, 5) });
      store.onChange(() => {
        throw new Error("boom");
      });
      const healthy = vi.fn();
      store.onChange(healthy);

      expect(() => store.record("prompts")).not.toThrow();
      expect(healthy).toHaveBeenCalledTimes(1);
      expect(store.getSummary().today).toEqual({ prompts: 1 });
    });
  });

  describe("observeHookEvent", () => {
    const prompt: AgentHookEvent = {
      paneId: "pane-1",
      sessionId: "sess-1",
      agentKind: "claude",
      type: "UserPromptSubmit",
      status: "thinking",
    };
    const permission: AgentHookEvent = {
      paneId: "pane-1",
      sessionId: "sess-1",
      agentKind: "claude",
      type: "PermissionRequest",
      status: "requires_input",
    };
    const sessionStart: AgentHookEvent = {
      paneId: "pane-1",
      sessionId: "sess-1",
      agentKind: "claude",
      type: "SessionStart",
      status: "thinking",
    };
    const createAgent: Effect = {
      kind: "CreateAgent",
      sessionId: "sess-1",
      paneId: "pane-1",
      agentKind: "claude",
      status: "thinking",
    };

    function build(monoValues: number[] = [0]) {
      let index = 0;
      return new StatsStore(tmpDir, {
        now: () => localMs(2026, 9, 5),
        monoNow: () => monoValues[Math.min(index++, monoValues.length - 1)],
      });
    }

    it("applies the mapped deltas to today's bucket", () => {
      const store = build();
      store.observeHookEvent(sessionStart, [createAgent], 4);
      expect(store.getSummary().today).toEqual({
        agentSessions: 1,
        maxConcurrentAgents: 4,
      });
    });

    it("carries block latency across calls", () => {
      const store = build([2_000, 5_000]);
      store.observeHookEvent(permission, [], 1);
      store.observeHookEvent(prompt, [], 1);
      expect(store.getSummary().today).toEqual({
        blocks: 1,
        prompts: 1,
        unblocks: 1,
        unblockMsTotal: 3_000,
        fastUnblocks: 1,
      });
    });

    it("emits onChange exactly once per call, not once per delta", () => {
      const store = build();
      const onChange = vi.fn();
      store.onChange(onChange);

      store.observeHookEvent(sessionStart, [createAgent], 2);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(store.getSummary().today).toEqual({
        agentSessions: 1,
        maxConcurrentAgents: 2,
      });
    });

    it("does not emit onChange for an event that maps to nothing", () => {
      const store = build();
      const onChange = vi.fn();
      store.onChange(onChange);

      store.observeHookEvent(sessionStart, [], 1);
      expect(onChange).not.toHaveBeenCalled();
      expect(store.getSummary().today).toEqual({});
    });

    it("debounces the save across a burst of events", () => {
      vi.useFakeTimers();
      const store = new StatsStore(tmpDir, { now: () => localMs(2026, 9, 5) });
      const toolCall: AgentHookEvent = {
        paneId: "pane-1",
        sessionId: "sess-1",
        agentKind: "claude",
        type: "PreToolUse",
        status: "working",
      };
      for (let i = 0; i < 20; i++) store.observeHookEvent(toolCall, [], 1);
      expect(fs.existsSync(statsPath)).toBe(false);

      vi.advanceTimersByTime(500);
      expect(readFile().days["2026-09-05"]).toEqual({ toolCalls: 20 });
    });

    it("is a no-op when collection is disabled", () => {
      const store = new StatsStore(tmpDir, {
        now: () => localMs(2026, 9, 5),
        isEnabled: () => false,
      });
      const onChange = vi.fn();
      store.onChange(onChange);

      store.observeHookEvent(prompt, [createAgent], 3);
      expect(store.getSummary().today).toEqual({});
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  it("getSummary returns copies the caller cannot mutate into the store", () => {
    const store = new StatsStore(tmpDir, { now: () => localMs(2026, 9, 5) });
    store.record("prompts", 2);

    const summary = store.getSummary();
    summary.today.prompts = 999;
    expect(store.getSummary().today.prompts).toBe(2);
  });
});
