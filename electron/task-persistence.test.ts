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
});
