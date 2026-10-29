import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NotificationRecord, AgentInfo } from "../../electron.d";

// ── Mock electronAPI ──────────────────────────────────────────────────────────
// Same pattern as agent-store-unseen.test.ts: install the stub before importing
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

const agentsApi = {
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
  agents: agentsApi,
  notifications: notificationsApi,
  shell: shellApi,
};

const navigateToAgent = vi.fn();
vi.mock("../../utils/agent-navigation", () => ({
  navigateToAgent: (agent: AgentInfo) => navigateToAgent(agent),
}));

const { useNotificationStore } = await import("../notification-store");
const { navigateToNotification } = await import(
  "../../utils/notification-navigation"
);
const { useAgentStore } = await import("../agent-store");
const { onPaletteViewRequest } = await import("../../utils/palette-request");

function makeRecord(over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: "n1",
    kind: "agent-responded",
    title: "Agent responded",
    body: "Agent — Project",
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

  it("keeps its list when a native click's re-read fails", async () => {
    onChangedCallback?.([makeRecord({ id: "kept" })]);
    notificationsApi.getAll.mockRejectedValueOnce(new Error("main is busy"));

    await onNavigateCallback?.("not-here-yet");

    expect(useNotificationStore.getState().notifications.map((n) => n.id)).toEqual([
      "kept",
    ]);
  });

  it("records a failed read, keeps the list, and clears it on retry", async () => {
    onChangedCallback?.([makeRecord({ id: "kept" })]);
    notificationsApi.getAll.mockRejectedValueOnce(new Error("main is busy"));

    await useNotificationStore.getState().retry();
    expect(useNotificationStore.getState().loadError).toBe("main is busy");
    expect(useNotificationStore.getState().notifications.map((n) => n.id)).toEqual([
      "kept",
    ]);

    notificationsApi.getAll.mockResolvedValueOnce([makeRecord({ id: "fresh" })]);
    await useNotificationStore.getState().retry();
    expect(useNotificationStore.getState().loadError).toBeNull();
    expect(useNotificationStore.getState().notifications.map((n) => n.id)).toEqual([
      "fresh",
    ]);
  });

  it("a retry drops its answer when a push landed meanwhile", async () => {
    let resolve!: (list: NotificationRecord[]) => void;
    notificationsApi.getAll.mockReturnValueOnce(new Promise((r) => (resolve = r)));

    const pending = useNotificationStore.getState().retry();
    onChangedCallback?.([makeRecord({ id: "pushed" })]);
    resolve([makeRecord({ id: "older" })]);
    await pending;

    expect(useNotificationStore.getState().notifications.map((n) => n.id)).toEqual([
      "pushed",
    ]);
  });

  it("actions proxy straight to IPC — main is the writer", async () => {
    await useNotificationStore.getState().markRead("a");
    await useNotificationStore.getState().markAllRead();
    await useNotificationStore.getState().clear();

    expect(notificationsApi.markRead).toHaveBeenCalledWith("a", null);
    expect(notificationsApi.markAllRead).toHaveBeenCalledWith(null);
    expect(notificationsApi.clear).toHaveBeenCalledWith(null);
    // No speculative local mutation: state only moves on the broadcast.
    expect(useNotificationStore.getState().notifications).toEqual([]);
  });

  it("marks a record on the host that keeps it, and every host's log for all", async () => {
    onChangedCallback?.([
      makeRecord({ id: "b1", kind: "automation-ran", hostId: "box" }),
      makeRecord({ id: "d1", hostId: "local" }),
    ]);
    await useNotificationStore.getState().markRead("b1");
    expect(notificationsApi.markRead).toHaveBeenCalledWith("b1", "box");
    await useNotificationStore.getState().markAllRead();
    expect(notificationsApi.markAllRead.mock.calls).toEqual([[null], ["box"]]);
    await useNotificationStore.getState().clear();
    expect(notificationsApi.clear.mock.calls).toEqual([[null], ["box"]]);
  });
});

describe("navigateToNotification", () => {
  it("navigates even when markRead rejects", async () => {
    notificationsApi.markRead.mockRejectedValueOnce(new Error("main is busy"));

    await navigateToNotification(
      makeRecord({ target: { type: "url", url: "https://x/pull/3" } }),
    );

    expect(shellApi.openExternal).toHaveBeenCalledWith("https://x/pull/3");
  });

  it("opens a url target externally", async () => {
    await navigateToNotification(
      makeRecord({ target: { type: "url", url: "https://x/pull/2" } }),
    );

    expect(shellApi.openExternal).toHaveBeenCalledWith("https://x/pull/2");
    expect(navigateToAgent).not.toHaveBeenCalled();
  });

  it("resolves an agent target from the agent store", async () => {
    const agent = { id: "t1" } as AgentInfo;
    useAgentStore.setState({ agents: [agent] });

    await navigateToNotification(
      makeRecord({ target: { type: "agent", agentId: "t1" } }),
    );

    expect(navigateToAgent).toHaveBeenCalledWith(agent);
    expect(agentsApi.get).not.toHaveBeenCalled();
  });

  it("falls back to agents.get when the agent is not cached", async () => {
    const agent = { id: "t2" } as AgentInfo;
    useAgentStore.setState({ agents: [] });
    agentsApi.get.mockResolvedValueOnce(agent);

    await navigateToNotification(
      makeRecord({ target: { type: "agent", agentId: "t2" } }),
    );

    expect(agentsApi.get).toHaveBeenCalledWith("t2");
    expect(navigateToAgent).toHaveBeenCalledWith(agent);
  });

  it("opens the stats palette view for a stats target", async () => {
    const seen: string[] = [];
    const off = onPaletteViewRequest((view) => seen.push(view));
    await navigateToNotification(makeRecord({ target: { type: "stats" } }));
    off();

    expect(seen).toEqual(["stats"]);
    expect(navigateToAgent).not.toHaveBeenCalled();
  });

  it("opens the stats palette view for a legacy null-target badge record", async () => {
    const seen: string[] = [];
    const off = onPaletteViewRequest((view) => seen.push(view));
    await navigateToNotification(
      makeRecord({ kind: "badge-unlocked", target: null }),
    );
    off();

    expect(seen).toEqual(["stats"]);
  });

  it("opens an automation target's page, on the host that keeps the record", async () => {
    const { onUiRequest } = await import("../../utils/ui-request");
    const requests: unknown[] = [];
    const off = onUiRequest((r) => requests.push(r));
    await navigateToNotification(
      makeRecord({
        id: "n7",
        kind: "automation-failed",
        hostId: "box",
        target: { type: "automation", automationId: "auto-1" },
      }),
    );
    off();
    expect(notificationsApi.markRead).toHaveBeenCalledWith("n7", "box");
    expect(requests).toEqual([{ type: "open-automation", hostId: "box", automationId: "auto-1" }]);
  });

  it("marks read and stops when the target is null", async () => {
    await navigateToNotification(makeRecord({ id: "n9", target: null }));

    expect(notificationsApi.markRead).toHaveBeenCalledWith("n9", null);
    expect(navigateToAgent).not.toHaveBeenCalled();
    expect(shellApi.openExternal).not.toHaveBeenCalled();
  });

  it("does not re-mark an already-read record", async () => {
    await navigateToNotification(makeRecord({ read: true, target: null }));

    expect(notificationsApi.markRead).not.toHaveBeenCalled();
  });
});
