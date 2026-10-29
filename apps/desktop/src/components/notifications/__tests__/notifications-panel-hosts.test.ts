import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { NotificationRecord } from "../../../electron.d";
import type { HostStatusInfo } from "../../../store/host-store";

// A static render reads a zustand store's initial state, so the two stores
// the panel reads are plain selectors over what each test sets.
const state = vi.hoisted(() => ({
  notifications: { notifications: [] as unknown[], unreadCount: 0, markRead: async () => {}, markAllRead: async () => {}, clear: async () => {} },
  hosts: { hosts: [] as unknown[] },
}));
vi.mock("../../../store/notification-store", () => ({
  useNotificationStore: (select: (s: typeof state.notifications) => unknown) => select(state.notifications),
}));
vi.mock("../../../store/host-store", () => ({
  useHostStore: (select: (s: typeof state.hosts) => unknown) => select(state.hosts),
}));

const { TooltipProvider } = await import("../../ui/Tooltip/Tooltip");
const { NotificationsPanel } = await import("../NotificationsPopover");

/** A run that fired on the box while no desktop was open, from the box's own log. */
const REMOTE_RUN: NotificationRecord = {
  id: "n1",
  kind: "automation-ran",
  title: "Morning triage ran",
  body: "Started Claude in Morning triage · Oct 29 09:00",
  timestamp: new Date().toISOString(),
  read: false,
  target: { type: "automation", automationId: "auto-1" },
  hostId: "box",
};

function render(records: NotificationRecord[]): string {
  state.notifications.notifications = records;
  state.notifications.unreadCount = records.length;
  state.hosts.hosts = [{ hostId: "box", spec: null, label: "wsl-box", status: "connected" } as HostStatusInfo];
  return renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(NotificationsPanel, { onNavigate: () => {} })),
  );
}

describe("the bell, with a remote host's log merged in", () => {
  it("shows a remote host's automation run, saying which host it fired on", () => {
    const html = render([REMOTE_RUN]);
    expect(html).toContain('data-kind="automation-ran"');
    expect(html).toContain("Morning triage ran");
    expect(html).toContain("Started Claude in Morning triage · Oct 29 09:00");
    expect(html).toMatch(/data-testid="notification-host"[^>]*>.*wsl-box/);
  });

  it("names no host for a record of this machine's", () => {
    const html = render([{ ...REMOTE_RUN, hostId: "local" }]);
    expect(html).toContain("Morning triage ran");
    expect(html).not.toContain('data-testid="notification-host"');
  });
});
