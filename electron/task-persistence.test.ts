import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { TaskManager } from "./task-persistence";
import type { TaskInfo } from "./task-persistence";

describe("TaskManager", () => {
  let tmpDir: string;
  let manager: TaskManager;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-task-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    manager = new TaskManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeTask(
    overrides: Partial<Omit<TaskInfo, "id" | "createdAt" | "updatedAt" | "activatedAt">> = {},
  ): TaskInfo {
    return manager.createTask({
      agentSessionId: `session-${crypto.randomUUID()}`,
      name: "Test task",
      status: "active",
      completedAt: null,
      projectId: null,
      projectName: null,
      workspacePath: "/project/main",
      cwd: "/project/main",
      agentKind: "claude",
      agentCommand: "claude",
      paneId: `pane-${crypto.randomUUID()}`,
      lastAgentStatus: null,
      resumedAt: null,
      ...overrides,
    });
  }

  describe("resumedAt field (ADR-118)", () => {
    it("defaults to null when a task is created", () => {
      const task = makeTask();
      expect(task.resumedAt).toBeNull();
    });

    it("can be set via updateTask", () => {
      const task = makeTask();
      const now = new Date().toISOString();
      const updated = manager.updateTask(task.id, { resumedAt: now });
      expect(updated).not.toBeNull();
      expect(updated!.resumedAt).toBe(now);
    });

    it("is preserved across save/load cycles", async () => {
      const task = makeTask();
      const now = new Date().toISOString();
      manager.updateTask(task.id, { resumedAt: now });

      // Wait for the debounced save
      await new Promise((r) => setTimeout(r, 600));

      // Reload from disk
      const freshManager = new TaskManager(tmpDir);
      const loaded = freshManager.getTaskBySessionId(task.agentSessionId);
      expect(loaded).not.toBeNull();
      expect(loaded!.resumedAt).toBe(now);
    });

    it("does not affect status filtering — active tasks with resumedAt are still returned", () => {
      const task1 = makeTask({ resumedAt: new Date().toISOString() });
      const task2 = makeTask({ resumedAt: null });
      makeTask({ status: "completed", resumedAt: null });

      const active = manager.getAllTasks({ status: "active" });
      const ids = active.map((t) => t.id);

      expect(ids).toContain(task1.id);
      expect(ids).toContain(task2.id);
      expect(active).toHaveLength(2);
    });

    it("can be queried to find tasks that have not yet been resumed", () => {
      const resumed = makeTask({ resumedAt: new Date().toISOString() });
      const notResumed = makeTask({ resumedAt: null });

      const active = manager.getAllTasks({ status: "active" });
      const needResume = active.filter((t) => !t.resumedAt);

      expect(needResume.map((t) => t.id)).toContain(notResumed.id);
      expect(needResume.map((t) => t.id)).not.toContain(resumed.id);
    });
  });

  describe("pruneOlderThan (ADR-136)", () => {
    function isoDaysAgo(days: number): string {
      return new Date(Date.now() - days * 86_400_000).toISOString();
    }

    it("removes non-active tasks older than the cutoff", () => {
      const old = makeTask({
        status: "completed",
        completedAt: isoDaysAgo(120),
      });
      const recent = makeTask({
        status: "completed",
        completedAt: isoDaysAgo(10),
      });
      const abandoned = makeTask({
        status: "abandoned",
        completedAt: isoDaysAgo(200),
      });

      const removed = manager.pruneOlderThan(90);

      expect(removed).toBe(2);
      expect(manager.getAllTasks().map((t) => t.id)).toEqual([recent.id]);
      // Sanity-check: tasks pruned were the old + abandoned ones
      expect(manager.getAllTasks().map((t) => t.id)).not.toContain(old.id);
      expect(manager.getAllTasks().map((t) => t.id)).not.toContain(abandoned.id);
    });

    it("never removes active tasks regardless of completedAt", () => {
      // Pathological: an active task with an old completedAt should be kept
      // (active tasks are exempt from retention by definition).
      const active = makeTask({
        status: "active",
        completedAt: isoDaysAgo(500),
      });
      const removed = manager.pruneOlderThan(90);
      expect(removed).toBe(0);
      expect(manager.getAllTasks().map((t) => t.id)).toContain(active.id);
    });

    it("treats tasks without completedAt as not-prunable", () => {
      const noCompleted = makeTask({
        status: "completed",
        completedAt: null,
      });
      const removed = manager.pruneOlderThan(90);
      expect(removed).toBe(0);
      expect(manager.getAllTasks().map((t) => t.id)).toContain(noCompleted.id);
    });

    it("returns 0 and no-ops when retentionDays <= 0", () => {
      makeTask({ status: "completed", completedAt: isoDaysAgo(1000) });
      const before = manager.getAllTasks().length;

      expect(manager.pruneOlderThan(0)).toBe(0);
      expect(manager.pruneOlderThan(-5)).toBe(0);
      expect(manager.pruneOlderThan(Number.NaN)).toBe(0);
      expect(manager.pruneOlderThan(Number.POSITIVE_INFINITY)).toBe(0);

      expect(manager.getAllTasks().length).toBe(before);
    });

    it("runs from the constructor and reports count via getLastPruneCount()", async () => {
      // Seed an old completed task with the existing manager, then flush to disk.
      const old = makeTask({
        status: "completed",
        completedAt: isoDaysAgo(200),
      });
      const recent = makeTask({
        status: "completed",
        completedAt: isoDaysAgo(5),
      });
      // Wait for debounced save
      await new Promise((r) => setTimeout(r, 600));

      // Reload with retentionDays = 90: the old task should be pruned at construction.
      const fresh = new TaskManager(tmpDir, 90);
      expect(fresh.getLastPruneCount()).toBe(1);
      expect(fresh.getAllTasks().map((t) => t.id)).toContain(recent.id);
      expect(fresh.getAllTasks().map((t) => t.id)).not.toContain(old.id);
    });

    it("constructor with retentionDays=0 disables pruning", async () => {
      makeTask({ status: "completed", completedAt: isoDaysAgo(1000) });
      await new Promise((r) => setTimeout(r, 600));

      const fresh = new TaskManager(tmpDir, 0);
      expect(fresh.getLastPruneCount()).toBe(0);
      expect(fresh.getAllTasks().length).toBe(1);
    });
  });
});
