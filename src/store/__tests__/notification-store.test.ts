import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NotificationRecord, TaskInfo } from "../../electron.d";

// ── Mock electronAPI ──────────────────────────────────────────────────────────
// Same pattern as task-store-unseen.test.ts: install the stub before importing
// the store, so its eager init and its create-time subscriptions see it.

let onChangedCallback: ((list: NotificationRecord[]) => void) | null = null;
let onNavigateCallback: ((id: string) => void) | null = null;

const notificationsApi = {
  getAll: vi.fn().mockResolvedValue([] as NotificationRecord[]),
  markRead: vi.fn().mockResolvedValue(undefined),
  markAllRead: vi.fn().mockResolvedValue(undefined),
  clear: vi.fn().mockResolvedValue(undefined),
  show: vi.fn().mockResolvedValue(true),
  onChanged: vi.fn((cb: (list: NotificationRecord[]) => void) => {
    onChangedCallback = cb;
    return () => {};
  }),
  onNavigate: vi.fn((cb: (id: string) => void) => {
    onNavigateCallback = cb;
    return () => {};
  }),
};

const tasksApi = {
  onUpdate: vi.fn(() => () => {}),
  get: vi.fn().mockResolvedValue(null),
  getActive: vi.fn().mockResolvedValue([]),
  getAll: vi.fn().mockResolvedValue([]),
  getUnseen: vi.fn().mockResolvedValue({ responded: [], requires_input: [] }),
  markSeen: vi.fn().mockResolvedValue(undefined),
};

const shellApi = { openExternal: vi.fn().mockResolvedValue(undefined) };

(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
  ...((window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI ?? {}),
  tasks: tasksApi,
  notifications: notificationsApi,
  shell: shellApi,
};

const navigateToTask = vi.fn();
vi.mock("../../utils/task-navigation", () => ({
  navigateToTask: (task: TaskInfo) => navigateToTask(task),
}));

const { useNotificationStore } = await import("../notification-store");
const { navigateToNotification } = await import(
  "../../utils/notification-navigation"
);
const { useTaskStore } = await import("../task-store");

function makeRecord(over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: "n1",
    kind: "agent-responded",
    title: "Agent responded",
    body: "Task — Project",
    timestamp: "2024-01-15T00:00:00Z",
    read: false,
    target: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useNotificationStore.setState({
    notifications: [],
    unreadCount: 0,
    loading: false,
    loaded: true,
  });
});

describe("useNotificationStore", () => {
  it("replaces the list wholesale on a changed broadcast", () => {
    useNotificationStore.setState({
      notifications: [makeRecord({ id: "stale" })],
      unreadCount: 1,
    });

    onChangedCallback?.([makeRecord({ id: "a" }), makeRecord({ id: "b" })]);

    expect(useNotificationStore.getState().notifications.map((n) => n.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("derives unreadCount from the broadcast list", () => {
    onChangedCallback?.([
      makeRecord({ id: "a", read: false }),
      makeRecord({ id: "b", read: true }),
      makeRecord({ id: "c", read: false }),
    ]);

    expect(useNotificationStore.getState().unreadCount).toBe(2);
  });

  it("routes a native click through the shared navigation helper", async () => {
    onChangedCallback?.([
      makeRecord({ id: "a", target: { type: "url", url: "https://x/pull/1" } }),
    ]);

    await onNavigateCallback?.("a");
    // The helper awaits markRead before dispatching.
    await new Promise((r) => setTimeout(r, 0));

    expect(shellApi.openExternal).toHaveBeenCalledWith("https://x/pull/1");
  });

  it("actions proxy straight to IPC — main is the writer", async () => {
    await useNotificationStore.getState().markRead("a");
    await useNotificationStore.getState().markAllRead();
    await useNotificationStore.getState().clear();

    expect(notificationsApi.markRead).toHaveBeenCalledWith("a");
    expect(notificationsApi.markAllRead).toHaveBeenCalled();
    expect(notificationsApi.clear).toHaveBeenCalled();
    // No speculative local mutation: state only moves on the broadcast.
    expect(useNotificationStore.getState().notifications).toEqual([]);
  });
});

describe("navigateToNotification", () => {
  it("opens a url target externally", async () => {
    await navigateToNotification(
      makeRecord({ target: { type: "url", url: "https://x/pull/2" } }),
    );

    expect(shellApi.openExternal).toHaveBeenCalledWith("https://x/pull/2");
    expect(navigateToTask).not.toHaveBeenCalled();
  });

  it("resolves a task target from the task store", async () => {
    const task = { id: "t1" } as TaskInfo;
    useTaskStore.setState({ tasks: [task] });

    await navigateToNotification(
      makeRecord({ target: { type: "task", taskId: "t1" } }),
    );

    expect(navigateToTask).toHaveBeenCalledWith(task);
    expect(tasksApi.get).not.toHaveBeenCalled();
  });

  it("falls back to tasks.get when the task is not cached", async () => {
    const task = { id: "t2" } as TaskInfo;
    useTaskStore.setState({ tasks: [] });
    tasksApi.get.mockResolvedValueOnce(task);

    await navigateToNotification(
      makeRecord({ target: { type: "task", taskId: "t2" } }),
    );

    expect(tasksApi.get).toHaveBeenCalledWith("t2");
    expect(navigateToTask).toHaveBeenCalledWith(task);
  });

  it("marks read and stops when the target is null", async () => {
    await navigateToNotification(makeRecord({ id: "n9", target: null }));

    expect(notificationsApi.markRead).toHaveBeenCalledWith("n9");
    expect(navigateToTask).not.toHaveBeenCalled();
    expect(shellApi.openExternal).not.toHaveBeenCalled();
  });

  it("does not re-mark an already-read record", async () => {
    await navigateToNotification(makeRecord({ read: true, target: null }));

    expect(notificationsApi.markRead).not.toHaveBeenCalled();
  });
});
