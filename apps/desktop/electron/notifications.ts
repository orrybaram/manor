import { app, BrowserWindow, Notification } from "electron";
import { execFile } from "node:child_process";
import type {
  NotificationKind,
  NotificationRecord,
  NotificationStore,
  NotificationTarget,
} from "./notification-store";
import type { PrComment } from "../src/lib/pr-info";
import type { PreferencesManager } from "./preferences";
import type { AgentInfo } from "./agent-persistence";
import type { AgentStatus } from "./terminal-host/types";
import type { StatCounter, StatsStore } from "./stats-store";
import type { BroadcastBus } from "./renderer-broadcast";
import type { AgentUnseenFlags, UnseenAgents } from "./agent-status/unseen-agents";
import type { Caller } from "./bridge/method";
import { HeadlessNotifier } from "./server/headless-notifier";

/**
 * An E2E run kept in the background (`electron/e2e-background.ts`). Read at
 * call time rather than imported: that module reads `app.isPackaged` when it
 * loads, and the many modules importing this one are loaded by tests that
 * mock `electron` without an `app`.
 */
function isE2eBackgroundRun(): boolean {
  return process.env.MANOR_E2E_BACKGROUND === "1" && app?.isPackaged === false;
}

/** Mirrors `PrNotifyEventKind` in `src/utils/pr-notifications.ts`. */
export type PrNotifyEventKind =
  | "comment"
  | "approved"
  | "changes-requested"
  | "checks-failed";

const PR_KIND_TO_NOTIFICATION_KIND: Record<PrNotifyEventKind, NotificationKind> = {
  comment: "pr-comment",
  approved: "pr-approved",
  "changes-requested": "pr-changes-requested",
  "checks-failed": "pr-checks-failed",
};

/**
 * Which `NotificationKind`s are PR outcomes worth counting.
 * `pr-comment` is deliberately absent — it is noise, not an outcome — as are
 * the `agent-*` kinds this same append site also handles.
 */
const NOTIFICATION_KIND_TO_STAT: Partial<Record<NotificationKind, StatCounter>> = {
  "pr-approved": "prApproved",
  "pr-changes-requested": "prChangesRequested",
  "pr-checks-failed": "prChecksFailed",
};

export type { AgentUnseenFlags };

/** What `notifications.show` carries: a PR event worth a native banner. */
export interface PrNotificationPayload {
  kind: PrNotifyEventKind;
  title: string;
  body: string;
  url?: string;
  comment?: PrComment;
}

/**
 * What the server's handlers reach notification state and side effects
 * through. The desktop fills it in with {@link Notifier}; a
 * server with no screen supplies the first four and leaves the banner out.
 */
export interface ServerNotifier {
  /**
   * Broadcast an `agents`/`updated` event with the current unseen flags, then
   * refresh the dock badge. The single send-site for the event; do not call
   * `webContents.send("agent-updated", ...)` directly.
   */
  sendAgentUpdate(agent: AgentInfo): void;
  updateDockBadge(): void;
  /**
   * Mark every notification about `agentId` read and broadcast the result.
   *
   * Paired with `agents:markSeen`: the moment the server accepts that the
   * user is looking at an agent's pane, the log entries for that agent stop
   * counting as unread. Without this the bell kept an indicator up for a
   * session already on screen, and it came back on every navigation away.
   */
  markAgentNotificationsRead(agentId: string): void;
  /**
   * Broadcast the full notification list. The single send-site for
   * `notifications.changed`. The list is capped at 200 records, so shipping
   * all of it on every mutation is deliberate — it makes renderer drift
   * impossible.
   */
  sendNotificationsUpdate(): void;
  /**
   * Show a native notification on demand for `caller` (e.g. PR update
   * alerts). Returns whether it was presented; `false` means the caller's
   * window is focused and the renderer should toast instead. Absent where
   * there is no window to focus-check, which reads as `false`.
   */
  showPrNotification?(payload: PrNotificationPayload, caller: Caller): boolean;
}

export interface NotifierOptions {
  /** The durable notification log. */
  notificationStore: NotificationStore;
  /** Usage stats. */
  statsStore: StatsStore;
  unseen: UnseenAgents;
  preferencesManager: PreferencesManager;
  /** Where broadcasts go: the composer's bus (the desktop's global sinks). */
  publish: BroadcastBus["publish"];
  /** The primary renderer window, read at call time. */
  getMainWindow: () => BrowserWindow | null;
  /** All live renderer windows, for focus-checking a caller's own. */
  getRendererWindows: () => BrowserWindow[];
}

/**
 * The window a `notifications.show` call is asking on behalf of, for the
 * focus check (suppress the native banner while that window is focused, so
 * the caller toasts instead).
 *
 * A local caller's id is its own `webContents.id` — the poller may be
 * running in a detached window, and it is that window's focus that
 * matters, not the primary's. A device has no window at all, and gets the
 * primary's.
 */
function windowForCaller(
  opts: Pick<NotifierOptions, "getMainWindow" | "getRendererWindows">,
  caller: Caller,
): BrowserWindow | null {
  if (caller.callerClass === "local") {
    const id = Number(caller.id);
    for (const win of opts.getRendererWindows()) {
      if (!win.isDestroyed() && win.webContents.id === id) return win;
    }
  }
  return opts.getMainWindow();
}

export function playNotificationSound(soundName: string | false): void {
  if (typeof soundName === "string") {
    execFile("afplay", [`/System/Library/Sounds/${soundName}.aiff`]);
  }
}

/**
 * The desktop's notifications: the log, the stats taps, the dock badge and
 * native banners, for one server's state.
 */
export class Notifier extends HeadlessNotifier implements ServerNotifier {
  declare protected readonly opts: NotifierOptions;

  constructor(opts: NotifierOptions) {
    super(opts);
  }

  override updateDockBadge(): void {
    const { preferencesManager, unseen } = this.opts;
    if (!preferencesManager.get("dockBadgeEnabled")) {
      app.dock?.setBadge("");
      return;
    }
    if (unseen.requiresInput.size > 0) {
      app.dock?.setBadge(unseen.requiresInput.size.toString());
    } else if (unseen.responded.size > 0) {
      app.dock?.setBadge("•");
    } else {
      app.dock?.setBadge("");
    }
  }

  /**
   * Present a silent native notification, suppressed while the window is focused.
   * Clicking it surfaces the window, then runs `onClick`. Single source of truth
   * for how the app shows native notifications and plays the configured sound.
   *
   * Returns whether a notification was actually presented. Callers that have an
   * in-app fallback (a toast) must branch on this rather than deciding for
   * themselves whether the window is focused: a renderer cannot see its own
   * focus reliably — `document.hasFocus()` is false whenever a `<webview>` pane
   * holds focus, while `win.isFocused()` is true, so both sides suppressing
   * independently dropped the event entirely.
   */
  private presentNotification(
    mainWindow: BrowserWindow | null,
    opts: {
      title: string;
      body: string;
      record: {
        kind: NotificationKind;
        target: NotificationTarget | null;
        comment?: PrComment;
      };
    },
  ): boolean {
    // Record *before* the focus check. A notification suppressed because the
    // window was focused is exactly the case the log exists for:
    // the user may have been looking at a different pane the whole time.
    const { notificationStore, statsStore, preferencesManager, publish } = this.opts;
    const record: NotificationRecord =
      notificationStore.append({
        kind: opts.record.kind,
        title: opts.title,
        body: opts.body,
        target: opts.record.target,
        comment: opts.record.comment,
      });
    const stat = NOTIFICATION_KIND_TO_STAT[opts.record.kind];
    if (stat) statsStore.record(stat);
    this.sendNotificationsUpdate();

    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) {
      return false;
    }
    // A test run must not put banners and sound on the developer's desktop; the
    // record above is still written, which is what the tests read.
    if (isE2eBackgroundRun()) return false;

    const notification = new Notification({
      title: opts.title,
      body: opts.body,
      silent: true,
    });
    notification.on("click", () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.show();
      mainWindow.focus();
      // One click path for banners and in-app rows alike: the renderer resolves
      // the record's target through `navigateToNotification`.
      // Broadcast rather than addressed, because "show me that
      // notification" is a place in the app, and every renderer looking at it
      // — a second window, a paired phone — should end up there too.
      publish("notifications", "navigate", record.id);
    });
    notification.show();
    playNotificationSound(preferencesManager.get("notificationSound"));
    return true;
  }

  maybeSendNotification(
    agent: AgentInfo,
    prevStatus: string | null | undefined,
    newStatus: AgentStatus,
  ): void {
    const { preferencesManager } = this.opts;
    let title: string;
    let kind: NotificationKind;
    if (
      newStatus === "responded" &&
      prevStatus !== "responded" &&
      preferencesManager.get("notifyOnResponse")
    ) {
      title = "Agent responded";
      kind = "agent-responded";
    } else if (
      newStatus === "requires_input" &&
      prevStatus !== "requires_input" &&
      preferencesManager.get("notifyOnRequiresInput")
    ) {
      title = "Agent needs input";
      kind = "agent-requires-input";
    } else {
      return;
    }

    // Any focused manor window toasts this itself, a detached one included,
    // so only a banner when none is focused.
    const focused = this.opts
      .getRendererWindows()
      .find((win) => !win.isDestroyed() && win.isFocused());
    this.presentNotification(focused ?? this.opts.getMainWindow(), {
      title,
      body: [agent.name || "Agent", agent.projectName].filter(Boolean).join(" — "),
      record: { kind, target: { type: "agent", agentId: agent.id } },
    });
  }

  /**
   * Show a native notification on demand, triggered by the renderer (e.g. for
   * PR update alerts). Returns whether it was presented; `false`
   * means the calling window is focused and the renderer should toast instead.
   */
  showPrNotification(payload: PrNotificationPayload, caller: Caller): boolean {
    return this.presentNotification(windowForCaller(this.opts, caller), {
      title: payload.title,
      body: payload.body,
      record: {
        kind: PR_KIND_TO_NOTIFICATION_KIND[payload.kind] ?? "pr-comment",
        target: payload.url ? { type: "url", url: payload.url } : null,
        comment: payload.kind === "comment" ? payload.comment : undefined,
      },
    });
  }
}
