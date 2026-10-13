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

import { Notifier } from "../notifications";
import { UnseenAgents } from "../agent-status/unseen-agents";
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
  let notifier: Notifier;
  const caller = { id: "1", callerClass: "local" } as const;
  const showPrNotification = (payload: Parameters<Notifier["showPrNotification"]>[0]) =>
    notifier.showPrNotification(payload, caller);

  beforeEach(() => {
    notificationStore = makeNotificationStore();
    statsStore = makeStatsStore();
    preferencesManager = makePreferencesManager();
    notifier = new Notifier({
      notificationStore: notificationStore as never,
      statsStore: statsStore as never,
      unseen: new UnseenAgents(),
      preferencesManager: preferencesManager as never,
      publish: vi.fn(),
      getMainWindow: () => null,
      getRendererWindows: () => [],
    });
  });

  it("records prApproved for an approved PR notification", () => {
    showPrNotification(
      { kind: "approved", title: "Approved", body: "body" },
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
    );

    expect(statsStore.record).toHaveBeenCalledTimes(1);
    expect(statsStore.record).toHaveBeenCalledWith("prChangesRequested");
  });

  it("records prChecksFailed for a checks-failed PR notification", () => {
    showPrNotification(
      { kind: "checks-failed", title: "Checks failed", body: "body" },
    );

    expect(statsStore.record).toHaveBeenCalledTimes(1);
    expect(statsStore.record).toHaveBeenCalledWith("prChecksFailed");
  });

  it("does not record a stat for a pr-comment notification", () => {
    showPrNotification(
      { kind: "comment", title: "New comment", body: "body" },
    );

    expect(notificationStore.append).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "pr-comment" }),
    );
    expect(statsStore.record).not.toHaveBeenCalled();
  });

  it("does not record a PR stat for an agent-responded notification", () => {
    const agent = { id: "a1", name: "Agent", projectName: "proj" } as AgentInfo;
    notifier.maybeSendNotification(agent, "working", "responded");

    expect(notificationStore.append).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent-responded" }),
    );
    expect(statsStore.record).not.toHaveBeenCalled();
  });
});
