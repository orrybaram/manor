import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { handleStreamEvent } from "./app-lifecycle";
import { TaskManager } from "./task-persistence";
import type { TaskInfo } from "./task-persistence";
import type { StreamEvent } from "./terminal-host/types";

// Mock BrowserWindow
const createMockBrowserWindow = () => {
  return {
    webContents: {
      send: vi.fn(),
      isDestroyed: () => false,
      mainFrame: true,
    },
    isDestroyed: () => false,
  } as any;
};

describe("handleStreamEvent", () => {
  let tmpDir: string;
  let taskManager: TaskManager;
  let mockWindow: any;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    taskManager = new TaskManager(tmpDir);
    mockWindow = createMockBrowserWindow();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function createTask(
    overrides: Partial<Omit<TaskInfo, "id" | "createdAt" | "updatedAt" | "activatedAt">> = {},
  ): TaskInfo {
    return taskManager.createTask({
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

  describe("cwd event handling", () => {
    it("updates task cwd when active task cwd differs from event cwd", () => {
      const task = createTask({ cwd: "/project/main", status: "active" });
      const paneId = task.paneId!;

      const event: StreamEvent = {
        type: "cwd",
        sessionId: paneId,
        cwd: "/project/main/src",
      };

      handleStreamEvent(event, mockWindow, taskManager);

      // Verify webContents.send was called with the cwd event
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        `pty-cwd-${paneId}`,
        "/project/main/src",
      );

      // Verify task was updated in taskManager
      const updated = taskManager.getTaskByPaneId(paneId);
      expect(updated).not.toBeNull();
      expect(updated!.cwd).toBe("/project/main/src");

      // Verify task-updated broadcast was sent
      const taskUpdatedCalls = mockWindow.webContents.send.mock.calls.filter(
        (call: any) => call[0] === "task-updated",
      );
      expect(taskUpdatedCalls.length).toBe(1);
      expect(taskUpdatedCalls[0][1].cwd).toBe("/project/main/src");
    });

    it("does not update task when cwd matches existing task cwd", () => {
      const task = createTask({ cwd: "/project/main", status: "active" });
      const paneId = task.paneId!;

      const event: StreamEvent = {
        type: "cwd",
        sessionId: paneId,
        cwd: "/project/main",
      };

      handleStreamEvent(event, mockWindow, taskManager);

      // Verify webContents.send was called with the cwd event
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        `pty-cwd-${paneId}`,
        "/project/main",
      );

      // Verify task-updated broadcast was NOT sent (no change)
      const taskUpdatedCalls = mockWindow.webContents.send.mock.calls.filter(
        (call: any) => call[0] === "task-updated",
      );
      expect(taskUpdatedCalls.length).toBe(0);
    });

    it("does not update a completed task", () => {
      const task = createTask({ cwd: "/project/main", status: "completed" });
      const paneId = task.paneId!;

      const event: StreamEvent = {
        type: "cwd",
        sessionId: paneId,
        cwd: "/project/main/src",
      };

      handleStreamEvent(event, mockWindow, taskManager);

      // Verify webContents.send was called with the cwd event to renderer
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        `pty-cwd-${paneId}`,
        "/project/main/src",
      );

      // Verify task was NOT updated
      const updated = taskManager.getTaskByPaneId(paneId);
      expect(updated!.cwd).toBe("/project/main");

      // Verify task-updated broadcast was NOT sent
      const taskUpdatedCalls = mockWindow.webContents.send.mock.calls.filter(
        (call: any) => call[0] === "task-updated",
      );
      expect(taskUpdatedCalls.length).toBe(0);
    });

    it("does not update task when there is no task for the paneId", () => {
      const nonExistentPaneId = `pane-${crypto.randomUUID()}`;

      const event: StreamEvent = {
        type: "cwd",
        sessionId: nonExistentPaneId,
        cwd: "/project/main/src",
      };

      handleStreamEvent(event, mockWindow, taskManager);

      // Verify webContents.send was called with the cwd event to renderer
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        `pty-cwd-${nonExistentPaneId}`,
        "/project/main/src",
      );

      // Verify task-updated broadcast was NOT sent
      const taskUpdatedCalls = mockWindow.webContents.send.mock.calls.filter(
        (call: any) => call[0] === "task-updated",
      );
      expect(taskUpdatedCalls.length).toBe(0);
    });

    it("forwards data events to renderer", () => {
      const paneId = `pane-${crypto.randomUUID()}`;

      const event: StreamEvent = {
        type: "data",
        sessionId: paneId,
        data: "hello",
      };

      handleStreamEvent(event, mockWindow, taskManager);

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        `pty-output-${paneId}`,
        "hello",
      );
    });

    it("forwards exit events to renderer", () => {
      const paneId = `pane-${crypto.randomUUID()}`;

      const event: StreamEvent = {
        type: "exit",
        sessionId: paneId,
      };

      handleStreamEvent(event, mockWindow, taskManager);

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        `pty-exit-${paneId}`,
      );
    });

    it("forwards error events to renderer", () => {
      const paneId = `pane-${crypto.randomUUID()}`;

      const event: StreamEvent = {
        type: "error",
        sessionId: paneId,
        message: "test error",
      };

      handleStreamEvent(event, mockWindow, taskManager);

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        `pty-error-${paneId}`,
        "test error",
      );
    });
  });

  describe("error handling", () => {
    it("handles errors from webContents.send gracefully", () => {
      const task = createTask({ cwd: "/project/main", status: "active" });
      const paneId = task.paneId!;

      let callCount = 0;
      mockWindow.webContents.send = vi.fn(() => {
        callCount++;
        // Only throw on the second call (task-updated broadcast), not on the pty-cwd broadcast
        if (callCount === 2) {
          throw new Error("Render frame was disposed");
        }
      });

      const event: StreamEvent = {
        type: "cwd",
        sessionId: paneId,
        cwd: "/project/main/src",
      };

      // Should not throw
      expect(() => {
        handleStreamEvent(event, mockWindow, taskManager);
      }).not.toThrow();

      // Task should still be updated
      const updated = taskManager.getTaskByPaneId(paneId);
      expect(updated!.cwd).toBe("/project/main/src");
    });

    it("logs non-disposed errors", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation();

      mockWindow.webContents.send = vi.fn(() => {
        throw new Error("Some other error");
      });

      const paneId = `pane-${crypto.randomUUID()}`;
      const event: StreamEvent = {
        type: "data",
        sessionId: paneId,
        data: "test",
      };

      handleStreamEvent(event, mockWindow, taskManager);

      expect(errorSpy).toHaveBeenCalledWith(
        "Error in stream event handler:",
        expect.any(Error),
      );

      errorSpy.mockRestore();
    });
  });

  describe("integration with taskManager updates", () => {
    it("persists cwd change across save/load cycles", async () => {
      const task = createTask({ cwd: "/project/main", status: "active" });
      const paneId = task.paneId!;

      const event: StreamEvent = {
        type: "cwd",
        sessionId: paneId,
        cwd: "/project/main/nested/dir",
      };

      handleStreamEvent(event, mockWindow, taskManager);

      // Wait for debounced save
      await new Promise((r) => setTimeout(r, 600));

      // Create fresh manager and verify persistence
      const freshManager = new TaskManager(tmpDir);
      const loaded = freshManager.getTaskByPaneId(paneId);
      expect(loaded).not.toBeNull();
      expect(loaded!.cwd).toBe("/project/main/nested/dir");
    });
  });
});
