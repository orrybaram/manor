/**
 * `AutomationStore` — automations and their runs on disk.
 *
 * Pinned: what create and update leave in `lastScheduledFor` (so the
 * scheduler never fires a time the user didn't mean), the 50-run ring and
 * the started run it never drops, runs leaving with their automation, and
 * surviving a missing or corrupt file without losing it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { AutomationStore, type AutomationStoreChange } from "../automation-store";
import {
  DEFAULT_MISSED_GRACE_MINUTES,
  validateAutomationInput,
  type AutomationInput,
} from "../../../src/lib/automations";

const NOW = Date.parse("2026-10-29T08:00:00.000Z");

function input(overrides: Partial<AutomationInput> = {}): AutomationInput {
  return {
    name: "Nightly triage",
    schedule: { cron: "0 9 * * *", timezone: "UTC" },
    projectId: "project-1",
    prompt: "Triage new issues",
    agentKind: "claude",
    workspace: { mode: "new" },
    ...overrides,
  };
}

describe("AutomationStore", () => {
  let tmpDir: string;
  let store: AutomationStore;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-automation-store-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    store = new AutomationStore(tmpDir);
  });

  afterEach(() => {
    store.flushNow();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a paused automation scheduled from its creation time", () => {
    const a = store.create(input(), NOW);
    expect(a).toMatchObject({
      enabled: false,
      nextRunAt: null,
      lastScheduledFor: "2026-10-29T08:00:00.000Z",
      missedGraceMinutes: DEFAULT_MISSED_GRACE_MINUTES,
    });
    expect(store.get(a.id)).toBe(a);
    expect(store.list()).toEqual([a]);

    const on = store.create(input({ enabled: true }), NOW);
    expect(on.nextRunAt).toBe("2026-10-29T09:00:00.000Z");
  });

  it("refuses invalid input", () => {
    expect(() => store.create(input({ name: "  " }), NOW)).toThrow("Name is required");
    expect(() => store.create(input({ schedule: { cron: "61 * * * *", timezone: "UTC" } }), NOW)).toThrow(
      "Invalid cron",
    );
    expect(store.list()).toEqual([]);
  });

  it("update changes only what the patch names", () => {
    const a = store.create(input({ enabled: true }), NOW);
    const later = NOW + 60_000;
    const updated = store.update(a.id, { prompt: "Something else" }, later);
    expect(updated).toMatchObject({
      prompt: "Something else",
      projectId: "project-1",
      lastScheduledFor: a.lastScheduledFor,
      updatedAt: new Date(later).toISOString(),
    });
    expect(store.update("nope", { name: "x" }, later)).toBeNull();
    expect(() => store.update(a.id, { agentKind: "gpt" as never }, later)).toThrow();
    expect(store.get(a.id)?.agentKind).toBe("claude");
  });

  it("a schedule change or a resume restarts the schedule from now", () => {
    const a = store.create(input({ enabled: true }), NOW);
    const later = NOW + 3 * 3_600_000;
    const rescheduled = store.update(a.id, { schedule: { cron: "0 * * * *", timezone: "UTC" } }, later);
    expect(rescheduled?.lastScheduledFor).toBe(new Date(later).toISOString());
    expect(rescheduled?.nextRunAt).toBe("2026-10-29T12:00:00.000Z");

    const paused = store.update(a.id, { enabled: false }, later + 1);
    expect(paused?.nextRunAt).toBeNull();
    expect(paused?.lastScheduledFor).toBe(new Date(later).toISOString());

    const resumed = store.update(a.id, { enabled: true }, later + 2);
    expect(resumed?.lastScheduledFor).toBe(new Date(later + 2).toISOString());
  });

  it("keeps the newest 50 runs per automation, newest first", () => {
    const a = store.create(input(), NOW);
    const b = store.create(input(), NOW);
    for (let i = 0; i < 60; i++) {
      store.appendRun({
        automationId: a.id,
        scheduledFor: new Date(NOW + i).toISOString(),
        firedAt: new Date(NOW + i).toISOString(),
        trigger: "schedule",
        outcome: "started",
        agentId: `agent-${i}`,
      });
    }
    store.appendRun({
      automationId: b.id,
      scheduledFor: new Date(NOW).toISOString(),
      firedAt: new Date(NOW).toISOString(),
      trigger: "manual",
      outcome: "failed",
      reason: "error",
    });

    const runs = store.runs(a.id);
    expect(runs).toHaveLength(50);
    expect(runs[0].agentId).toBe("agent-59");
    expect(runs[49].agentId).toBe("agent-10");
    expect(store.runs(b.id)).toHaveLength(1);
    expect(store.lastStartedRun(a.id)?.agentId).toBe("agent-59");
    expect(store.lastStartedRun(b.id)).toBeNull();

    store.flushNow();
    const reloaded = new AutomationStore(tmpDir);
    expect(reloaded.runs(a.id).map((r) => r.id)).toEqual(runs.map((r) => r.id));
  });

  it("never trims away the newest started run", () => {
    const a = store.create(input(), NOW);
    const base = { automationId: a.id, trigger: "schedule" } as const;
    store.appendRun({
      ...base,
      scheduledFor: new Date(NOW).toISOString(),
      firedAt: new Date(NOW).toISOString(),
      outcome: "started",
      agentId: "agent-busy",
    });
    for (let i = 1; i <= 60; i++) {
      store.appendRun({
        ...base,
        scheduledFor: new Date(NOW + i * 60_000).toISOString(),
        firedAt: new Date(NOW + i * 60_000).toISOString(),
        outcome: "skipped",
        reason: "still-working",
      });
    }
    expect(store.runs(a.id)).toHaveLength(50);
    expect(store.lastStartedRun(a.id)?.agentId).toBe("agent-busy");

    store.flushNow();
    const reloaded = new AutomationStore(tmpDir);
    expect(reloaded.runs(a.id)).toHaveLength(50);
    expect(reloaded.lastStartedRun(a.id)?.agentId).toBe("agent-busy");
  });

  it("remove drops the automation and its runs, on disk too", () => {
    const a = store.create(input(), NOW);
    store.appendRun({
      automationId: a.id,
      scheduledFor: new Date(NOW).toISOString(),
      firedAt: new Date(NOW).toISOString(),
      trigger: "manual",
      outcome: "started",
    });
    expect(store.remove(a.id)).toBe(true);
    expect(store.remove(a.id)).toBe(false);
    expect(store.get(a.id)).toBeNull();
    expect(store.runs(a.id)).toEqual([]);

    store.flushNow();
    const reloaded = new AutomationStore(tmpDir);
    expect(reloaded.list()).toEqual([]);
    expect(reloaded.runs(a.id)).toEqual([]);
  });

  it("survives a corrupt or missing file, moving the corrupt one aside", () => {
    fs.writeFileSync(path.join(tmpDir, "automations.json"), "{ not json");
    fs.writeFileSync(path.join(tmpDir, "automation-runs.json"), '{"runs": [{"id": 3}]}');
    const log = vi.fn();
    const corrupt = new AutomationStore(tmpDir, log);
    expect(corrupt.list()).toEqual([]);
    const aside = fs.readdirSync(tmpDir).filter((f) => f.startsWith("automations.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmpDir, aside[0]), "utf-8")).toBe("{ not json");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("is corrupt"));

    const a = corrupt.create(input(), NOW);
    corrupt.flushNow();
    expect(new AutomationStore(tmpDir).get(a.id)?.name).toBe("Nightly triage");
    expect(fs.readdirSync(tmpDir).some((f) => f.endsWith(".tmp"))).toBe(false);

    const missing = new AutomationStore(path.join(tmpDir, "does-not-exist"), log);
    expect(missing.list()).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("logs a debounced save that fails instead of throwing from the timer", () => {
    vi.useFakeTimers();
    try {
      const blocker = path.join(tmpDir, "blocker");
      fs.writeFileSync(blocker, "");
      const log = vi.fn();
      const broken = new AutomationStore(path.join(blocker, "data"), log);
      broken.create(input(), NOW);
      expect(() => vi.advanceTimersByTime(500)).not.toThrow();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("saving automations failed"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes every change at once after writeThrough, so a run recorded during shutdown is kept", () => {
    const a = store.create(input(), NOW);
    store.writeThrough();
    store.appendRun({
      automationId: a.id,
      scheduledFor: new Date(NOW).toISOString(),
      firedAt: new Date(NOW).toISOString(),
      trigger: "schedule",
      outcome: "started",
      paneId: "pane-1",
    });
    // No flush and no timer: it is on disk already.
    expect(new AutomationStore(tmpDir).runs(a.id).map((r) => r.paneId)).toEqual(["pane-1"]);
  });

  it("tells listeners about every change", () => {
    const changes: AutomationStoreChange[] = [];
    const off = store.onChange((c) => changes.push(c));
    const a = store.create(input({ enabled: true }), NOW);
    store.setScheduled(a.id, a.lastScheduledFor, a.nextRunAt); // no-op
    store.setScheduled(a.id, "2026-10-29T09:00:00.000Z", "2026-10-30T09:00:00.000Z");
    store.remove(a.id);
    off();
    store.create(input(), NOW);
    expect(changes.map((c) => c.type)).toEqual(["automation", "automation", "removed"]);
  });
});

describe("validateAutomationInput", () => {
  it("names the first problem", () => {
    expect(validateAutomationInput(input())).toBeNull();
    expect(validateAutomationInput(input({ prompt: "" }))).toBe("Prompt is required");
    expect(validateAutomationInput(input({ agentKind: "gpt" as never }))).toMatch(/agent kind/);
    expect(validateAutomationInput(input({ schedule: { cron: "0 9 * *", timezone: "UTC" } }))).toMatch(
      /5 fields/,
    );
    expect(
      validateAutomationInput(input({ schedule: { cron: "0 9 * * *", timezone: "Mars/Olympus" } })),
    ).toMatch(/timezone/);
    expect(validateAutomationInput(input({ workspace: { mode: "reuse", workspacePath: "" } }))).toMatch(
      /workspace/,
    );
    expect(validateAutomationInput(input({ workspace: { mode: "new", keepLast: 0 } }))).toMatch(/Keep last/);
  });
});
