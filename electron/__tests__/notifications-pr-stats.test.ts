import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mock electron ──────────────────────────────────────────────────────────────
vi.mock("electron", () => ({
  app: { dock: { setBadge: vi.fn() } },
  BrowserWindow: class {},
  Notification: class {
    on() {}
    show() {}
  },
}));

import {
  setNotificationStore,
  setStatsStore,
  showPrNotification,
  maybeSendNotification,
} from "../notifications";
import type { AgentInfo } from "../agent-persistence";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeNotificationStore() {
  return {
    append: vi.fn((input: { kind: string }) => ({
      id: "n1",
      kind: input.kind,
      title: "t",
      body: "b",
      timestamp: new Date().toISOString(),
      read: false,
      target: null,
    })),
    getAll: vi.fn(() => []),
  };
}

function makeStatsStore() {
  return { record: vi.fn() };
}

function makePreferencesManager(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    notifyOnResponse: true,
    notifyOnRequiresInput: true,
    dockBadgeEnabled: false,
    notificationSound: false,
    ...overrides,
  };
  return { get: vi.fn((key: string) => values[key]) };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("PR notification stats taps", () => {
  let notificationStore: ReturnType<typeof makeNotificationStore>;
  let statsStore: ReturnType<typeof makeStatsStore>;
  let preferencesManager: ReturnType<typeof makePreferencesManager>;

  beforeEach(() => {
    notificationStore = makeNotificationStore();
    statsStore = makeStatsStore();
    preferencesManager = makePreferencesManager();
    setNotificationStore(notificationStore as never);
    setStatsStore(statsStore as never);
  });

  it("records prApproved for an approved PR notification", () => {
    showPrNotification(
      { kind: "approved", title: "Approved", body: "body" },
      null,
      preferencesManager as never,
    );

    expect(notificationStore.append).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "pr-approved" }),
    );
    expect(statsStore.record).toHaveBeenCalledTimes(1);
    expect(statsStore.record).toHaveBeenCalledWith("prApproved");
  });

  it("records prChangesRequested for a changes-requested PR notification", () => {
    showPrNotification(
      { kind: "changes-requested", title: "Changes requested", body: "body" },
      null,
      preferencesManager as never,
    );

    expect(statsStore.record).toHaveBeenCalledTimes(1);
    expect(statsStore.record).toHaveBeenCalledWith("prChangesRequested");
  });

  it("records prChecksFailed for a checks-failed PR notification", () => {
    showPrNotification(
      { kind: "checks-failed", title: "Checks failed", body: "body" },
      null,
      preferencesManager as never,
    );

    expect(statsStore.record).toHaveBeenCalledTimes(1);
    expect(statsStore.record).toHaveBeenCalledWith("prChecksFailed");
  });

  it("does not record a stat for a pr-comment notification", () => {
    showPrNotification(
      { kind: "comment", title: "New comment", body: "body" },
      null,
      preferencesManager as never,
    );

    expect(notificationStore.append).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "pr-comment" }),
    );
    expect(statsStore.record).not.toHaveBeenCalled();
  });

  it("does not record a PR stat for an agent-responded notification", () => {
    const agent = { id: "a1", name: "Agent", projectName: "proj" } as AgentInfo;
    maybeSendNotification(agent, "working", "responded", null, preferencesManager as never);

    expect(notificationStore.append).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent-responded" }),
    );
    expect(statsStore.record).not.toHaveBeenCalled();
  });

  it("does not throw when no stats store is registered", () => {
    setStatsStore(null);

    expect(() =>
      showPrNotification(
        { kind: "approved", title: "Approved", body: "body" },
        null,
        preferencesManager as never,
      ),
    ).not.toThrow();
  });
});
