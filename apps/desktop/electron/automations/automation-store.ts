import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import {
  DEFAULT_MISSED_GRACE_MINUTES,
  validateAutomationInput,
  type Automation,
  type AutomationInput,
  type AutomationRun,
} from "../../src/lib/automations";
import { isValidCron, nextRunAfter } from "./cron";

/**
 * Automation persistence model
 *
 * Mirrors `NotificationStore`: in-memory state backed by JSON files in the
 * data dir (`automations.json`, `automation-runs.json`), writes debounced
 * through a single timer, and a missing or corrupt file read as empty.
 *
 * The store keeps `lastScheduledFor` honest so the scheduler never fires an
 * occurrence the user didn't mean: it is the creation time on create, and it
 * moves to "now" when a paused automation is resumed or its schedule changes,
 * so time spent paused (or under the old schedule) never counts as missed.
 * `nextRunAt` is computed here on every write and null while paused.
 */

interface PersistedAutomations {
  automations: Automation[];
}

interface PersistedRuns {
  runs: AutomationRun[];
}

/** Runs kept per automation, newest first. */
const MAX_RUNS_PER_AUTOMATION = 50;

export type AutomationStoreChange =
  | { type: "automation"; automationId: string }
  | { type: "removed"; automationId: string }
  | { type: "run"; automationId: string; run: AutomationRun };

export class AutomationStore {
  private dataDir: string;
  private automations: Automation[];
  /** automationId → runs, newest first. */
  private runsById = new Map<string, AutomationRun[]>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(change: AutomationStoreChange) => void>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.automations = this.loadAutomations();
    const known = new Set(this.automations.map((a) => a.id));
    for (const run of this.loadRuns()) {
      // A run whose automation is gone would be an orphan nobody can see.
      if (!known.has(run.automationId)) continue;
      const list = this.runsById.get(run.automationId) ?? [];
      list.push(run);
      this.runsById.set(run.automationId, list);
    }
    for (const list of this.runsById.values()) {
      list.sort((a, b) => Date.parse(b.firedAt) - Date.parse(a.firedAt));
      list.splice(MAX_RUNS_PER_AUTOMATION);
    }
  }

  private automationsFilePath(): string {
    return path.join(this.dataDir, "automations.json");
  }

  private runsFilePath(): string {
    return path.join(this.dataDir, "automation-runs.json");
  }

  private loadAutomations(): Automation[] {
    try {
      const state: PersistedAutomations = JSON.parse(
        fs.readFileSync(this.automationsFilePath(), "utf-8"),
      );
      return (state.automations ?? []).filter(isValidAutomation);
    } catch {
      return [];
    }
  }

  private loadRuns(): AutomationRun[] {
    try {
      const state: PersistedRuns = JSON.parse(fs.readFileSync(this.runsFilePath(), "utf-8"));
      return (state.runs ?? []).filter(isValidRun);
    } catch {
      return [];
    }
  }

  private writeStateSync(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const automations: PersistedAutomations = { automations: this.automations };
    fs.writeFileSync(this.automationsFilePath(), JSON.stringify(automations, null, 2));
    const runs: PersistedRuns = { runs: [...this.runsById.values()].flat() };
    fs.writeFileSync(this.runsFilePath(), JSON.stringify(runs, null, 2));
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

  /** Subscribes to every change; returns the unsubscribe. */
  onChange(listener: (change: AutomationStoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(change: AutomationStoreChange): void {
    this.saveState();
    for (const listener of this.listeners) listener(change);
  }

  list(): Automation[] {
    return this.automations;
  }

  get(id: string): Automation | null {
    return this.automations.find((a) => a.id === id) ?? null;
  }

  /** Throws with the validation message when `input` is invalid. */
  create(input: AutomationInput, now: number): Automation {
    assertValid(input);
    const iso = new Date(now).toISOString();
    const enabled = input.enabled ?? false;
    const automation: Automation = {
      id: crypto.randomUUID(),
      name: input.name.trim(),
      enabled,
      schedule: { ...input.schedule },
      projectId: input.projectId,
      prompt: input.prompt,
      agentKind: input.agentKind,
      workspace: { ...input.workspace },
      missedGraceMinutes: input.missedGraceMinutes ?? DEFAULT_MISSED_GRACE_MINUTES,
      createdAt: iso,
      updatedAt: iso,
      lastScheduledFor: iso,
      nextRunAt: enabled ? nextRunAfter(input.schedule, now) : null,
    };
    this.automations.push(automation);
    this.changed({ type: "automation", automationId: automation.id });
    return automation;
  }

  /**
   * Applies `patch` over the automation. Only the fields in `patch` change;
   * `projectId` in particular never moves unless the patch names it. Throws
   * when the result is invalid; returns null for an unknown id.
   */
  update(id: string, patch: Partial<AutomationInput>, now: number): Automation | null {
    const index = this.automations.findIndex((a) => a.id === id);
    if (index === -1) return null;
    const current = this.automations[index];
    const merged: AutomationInput = {
      name: patch.name ?? current.name,
      enabled: patch.enabled ?? current.enabled,
      schedule: patch.schedule ? { ...patch.schedule } : current.schedule,
      projectId: patch.projectId ?? current.projectId,
      prompt: patch.prompt ?? current.prompt,
      agentKind: patch.agentKind ?? current.agentKind,
      workspace: patch.workspace ? { ...patch.workspace } : current.workspace,
      missedGraceMinutes: patch.missedGraceMinutes ?? current.missedGraceMinutes,
    };
    assertValid(merged);
    const iso = new Date(now).toISOString();
    const enabled = merged.enabled ?? false;
    const resumed = enabled && !current.enabled;
    const rescheduled =
      merged.schedule.cron !== current.schedule.cron ||
      merged.schedule.timezone !== current.schedule.timezone;
    const next: Automation = {
      ...current,
      name: merged.name.trim(),
      enabled,
      schedule: merged.schedule,
      projectId: merged.projectId,
      prompt: merged.prompt,
      agentKind: merged.agentKind,
      workspace: merged.workspace,
      missedGraceMinutes: merged.missedGraceMinutes ?? DEFAULT_MISSED_GRACE_MINUTES,
      updatedAt: iso,
      lastScheduledFor: resumed || rescheduled ? iso : current.lastScheduledFor,
      nextRunAt: enabled ? nextRunAfter(merged.schedule, now) : null,
    };
    this.automations[index] = next;
    this.changed({ type: "automation", automationId: id });
    return next;
  }

  /** Removes the automation and its runs. Returns whether it existed. */
  remove(id: string): boolean {
    const index = this.automations.findIndex((a) => a.id === id);
    if (index === -1) return false;
    this.automations.splice(index, 1);
    this.runsById.delete(id);
    this.changed({ type: "removed", automationId: id });
    return true;
  }

  /**
   * The scheduler's bookkeeping: which occurrence it last handled and when
   * the next one is. Leaves `updatedAt` alone — the user changed nothing.
   */
  setScheduled(id: string, lastScheduledFor: string, nextRunAt: string | null): void {
    const automation = this.get(id);
    if (!automation) return;
    if (automation.lastScheduledFor === lastScheduledFor && automation.nextRunAt === nextRunAt) {
      return;
    }
    automation.lastScheduledFor = lastScheduledFor;
    automation.nextRunAt = nextRunAt;
    this.changed({ type: "automation", automationId: id });
  }

  /**
   * Records a run, keeping the newest `MAX_RUNS_PER_AUTOMATION` for its
   * automation. A run for an unknown automation is returned but not kept.
   */
  appendRun(input: Omit<AutomationRun, "id">): AutomationRun {
    const run: AutomationRun = { id: crypto.randomUUID(), ...input };
    if (!this.get(run.automationId)) return run;
    const list = this.runsById.get(run.automationId) ?? [];
    list.unshift(run);
    list.splice(MAX_RUNS_PER_AUTOMATION);
    this.runsById.set(run.automationId, list);
    this.changed({ type: "run", automationId: run.automationId, run });
    return run;
  }

  /** The automation's runs, newest first. */
  runs(automationId: string): AutomationRun[] {
    return this.runsById.get(automationId) ?? [];
  }

  /** The newest run that started an agent, for the overlap check. */
  lastStartedRun(automationId: string): AutomationRun | null {
    return this.runs(automationId).find((r) => r.outcome === "started") ?? null;
  }
}

function assertValid(input: AutomationInput): void {
  const problem =
    validateAutomationInput(input) ??
    (isValidCron(input.schedule.cron, input.schedule.timezone) ? null : `Invalid cron: ${input.schedule.cron}`);
  if (problem) throw new Error(problem);
}

function isValidAutomation(record: unknown): record is Automation {
  if (!record || typeof record !== "object") return false;
  const a = record as Partial<Automation>;
  return (
    typeof a.id === "string" &&
    typeof a.projectId === "string" &&
    typeof a.schedule?.cron === "string" &&
    typeof a.schedule?.timezone === "string" &&
    typeof a.lastScheduledFor === "string"
  );
}

function isValidRun(record: unknown): record is AutomationRun {
  if (!record || typeof record !== "object") return false;
  const r = record as Partial<AutomationRun>;
  return (
    typeof r.id === "string" &&
    typeof r.automationId === "string" &&
    typeof r.firedAt === "string" &&
    typeof r.outcome === "string"
  );
}
