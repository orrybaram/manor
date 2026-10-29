import { describe, it, expect, beforeEach, vi } from "vitest";

const shown = vi.hoisted(() => ({ count: 0 }));

vi.mock("electron", () => ({
  app: { dock: { setBadge: vi.fn() } },
  BrowserWindow: class {},
  Notification: class {
    on() {}
    show() {
      shown.count++;
    }
  },
}));

import { Notifier } from "../notifications";
import { UnseenAgents } from "../agent-status/unseen-agents";
import type { AgentInfo } from "../agent-persistence";

function fakeWindow(focused: boolean) {
  return { isDestroyed: () => false, isFocused: () => focused, webContents: { id: 1 } };
}

function makeNotifier(windows: ReturnType<typeof fakeWindow>[]) {
  return new Notifier({
    notificationStore: {
      append: vi.fn(() => ({ id: "n1", read: false, target: null })),
      getAll: vi.fn(() => []),
    } as never,
    statsStore: { record: vi.fn() } as never,
    unseen: new UnseenAgents(),
    preferencesManager: {
      get: vi.fn((key: string) => (key === "notificationSound" ? false : true)),
    } as never,
    publish: vi.fn(),
    getMainWindow: () => windows[0] as never,
    getRendererWindows: () => windows as never,
  });
}

const agent = { id: "a1", name: "Agent", projectName: "proj" } as AgentInfo;

describe("agent banner focus check", () => {
  beforeEach(() => {
    shown.count = 0;
  });

  it("shows a banner when no manor window is focused", () => {
    makeNotifier([fakeWindow(false), fakeWindow(false)]).maybeSendNotification(
      agent,
      "working",
      "responded",
    );
    expect(shown.count).toBe(1);
  });

  it("leaves it to the toast when a detached window is focused", () => {
    makeNotifier([fakeWindow(false), fakeWindow(true)]).maybeSendNotification(
      agent,
      "working",
      "requires_input",
    );
    expect(shown.count).toBe(0);
  });
});
