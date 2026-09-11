import { describe, it, expect, vi, beforeEach } from "vitest";
import { diffPrEvents, deliverPrNotifications } from "../pr-notifications";
import { useToastStore } from "../../store/toast-store";
import type { PrInfo } from "../../store/project-store";
import type { PrComment } from "../../lib/pr-info";
import type { AppPreferences } from "../../electron.d";

function makePr(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 123,
    state: "OPEN",
    title: "Add feature",
    url: "https://github.com/o/r/pull/123",
    ...overrides,
  };
}

describe("diffPrEvents", () => {
  it("returns [] when prev is null/undefined (no baseline)", () => {
    expect(diffPrEvents(null, makePr())).toEqual([]);
    expect(diffPrEvents(undefined, makePr())).toEqual([]);
  });

  it("returns [] when next is null/undefined", () => {
    expect(diffPrEvents(makePr(), null)).toEqual([]);
    expect(diffPrEvents(makePr(), undefined)).toEqual([]);
  });

  it("emits a comment event when commentCount increases", () => {
    const prev = makePr({ commentCount: 1 });
    const next = makePr({ commentCount: 3 });
    const events = diffPrEvents(prev, next);
    expect(events).toEqual([
      { kind: "comment", title: "PR #123 — new comment", body: "Add feature" },
    ]);
  });

  it("attaches the latest comment to a comment event when the fetcher knows it", () => {
    const latestComment = {
      author: "alice",
      body: "One nit.",
      url: "https://github.com/o/r/pull/123#issuecomment-9",
      createdAt: "2026-09-05T10:00:00Z",
    };
    const events = diffPrEvents(
      makePr({ commentCount: 1 }),
      makePr({ commentCount: 2, latestComment }),
    );
    expect(events).toEqual([
      {
        kind: "comment",
        title: "PR #123 — new comment",
        body: "Add feature",
        comment: latestComment,
      },
    ]);
  });

  it("leaves `comment` off entirely when there is no latest comment", () => {
    const [event] = diffPrEvents(
      makePr({ commentCount: 1 }),
      makePr({ commentCount: 2, latestComment: null }),
    );
    expect("comment" in event).toBe(false);
  });

  it("does not emit a comment event when commentCount is unchanged", () => {
    const prev = makePr({ commentCount: 2 });
    const next = makePr({ commentCount: 2 });
    expect(diffPrEvents(prev, next)).toEqual([]);
  });

  it("emits an approved event on transition to APPROVED", () => {
    const prev = makePr({ reviewDecision: "REVIEW_REQUIRED" });
    const next = makePr({ reviewDecision: "APPROVED" });
    expect(diffPrEvents(prev, next)).toEqual([
      { kind: "approved", title: "PR #123 approved", body: "Add feature" },
    ]);
  });

  it("does not re-emit approved when already APPROVED", () => {
    const prev = makePr({ reviewDecision: "APPROVED" });
    const next = makePr({ reviewDecision: "APPROVED" });
    expect(diffPrEvents(prev, next)).toEqual([]);
  });

  it("emits a changes-requested event on transition", () => {
    const prev = makePr({ reviewDecision: "REVIEW_REQUIRED" });
    const next = makePr({ reviewDecision: "CHANGES_REQUESTED" });
    expect(diffPrEvents(prev, next)).toEqual([
      {
        kind: "changes-requested",
        title: "PR #123 — changes requested",
        body: "Add feature",
      },
    ]);
  });

  it("emits a checks-failed event when failing goes from 0 to >0", () => {
    const prev = makePr({
      checks: { total: 3, passing: 3, failing: 0, pending: 0 },
    });
    const next = makePr({
      checks: { total: 3, passing: 2, failing: 1, pending: 0 },
    });
    expect(diffPrEvents(prev, next)).toEqual([
      {
        kind: "checks-failed",
        title: "PR #123 — CI checks failing",
        body: "Add feature",
      },
    ]);
  });

  it("does not re-emit checks-failed when already failing", () => {
    const prev = makePr({
      checks: { total: 3, passing: 2, failing: 1, pending: 0 },
    });
    const next = makePr({
      checks: { total: 3, passing: 1, failing: 2, pending: 0 },
    });
    expect(diffPrEvents(prev, next)).toEqual([]);
  });

  it("returns [] when nothing changed", () => {
    const prev = makePr({
      commentCount: 1,
      reviewDecision: "APPROVED",
      checks: { total: 1, passing: 1, failing: 0, pending: 0 },
    });
    const next = makePr({
      commentCount: 1,
      reviewDecision: "APPROVED",
      checks: { total: 1, passing: 1, failing: 0, pending: 0 },
    });
    expect(diffPrEvents(prev, next)).toEqual([]);
  });

  it("can emit multiple events from a single diff", () => {
    const prev = makePr({ commentCount: 0, reviewDecision: "REVIEW_REQUIRED" });
    const next = makePr({
      commentCount: 2,
      reviewDecision: "CHANGES_REQUESTED",
    });
    const kinds = diffPrEvents(prev, next).map((e) => e.kind);
    expect(kinds).toEqual(["comment", "changes-requested"]);
  });
});

describe("deliverPrNotifications", () => {
  const show = vi.fn();
  const prefs = {
    notifyOnPrComment: true,
    notifyOnPrApproved: true,
    notifyOnPrChangesRequested: true,
    notifyOnPrChecksFailed: true,
  } as unknown as AppPreferences;

  beforeEach(() => {
    show.mockReset();
    useToastStore.setState({ toasts: [] });
    const win = globalThis.window as unknown as Record<string, unknown>;
    const api = win.electronAPI as Record<string, unknown>;
    api.notifications = { ...(api.notifications as object), show };
    api.shell = { openExternal: vi.fn() };
  });

  /** Wait out the `notifications.show` promise the delivery path awaits. */
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("asks main to notify and does not toast when main presented it", async () => {
    show.mockResolvedValue(true);

    deliverPrNotifications(
      makePr({ commentCount: 1 }),
      makePr({ commentCount: 2 }),
      prefs,
    );
    await flush();

    expect(show).toHaveBeenCalledWith({
      kind: "comment",
      title: "PR #123 — new comment",
      body: "Add feature",
      url: "https://github.com/o/r/pull/123",
    });
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("sends the comment along and deep-links to it instead of the PR", async () => {
    show.mockResolvedValue(true);
    const latestComment = {
      author: "alice",
      body: "One nit.",
      url: "https://github.com/o/r/pull/123#issuecomment-9",
      createdAt: "2026-09-05T10:00:00Z",
    };

    deliverPrNotifications(
      makePr({ commentCount: 1 }),
      makePr({ commentCount: 2, latestComment }),
      prefs,
    );
    await flush();

    expect(show).toHaveBeenCalledWith({
      kind: "comment",
      title: "PR #123 — new comment",
      body: "Add feature",
      url: latestComment.url,
      comment: latestComment,
    });
  });

  it("falls back to a toast when main declines (window focused)", async () => {
    show.mockResolvedValue(false);

    deliverPrNotifications(
      makePr({ commentCount: 1 }),
      makePr({ commentCount: 2 }),
      prefs,
    );
    await flush();

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe("PR #123 — new comment");
    expect(toasts[0].status).toBe("success");
  });

  /**
   * Regression: `document.hasFocus()` is false while a `<webview>` pane holds
   * focus even though the window IS focused, so main suppressed the native
   * notification and the renderer skipped the toast — the event vanished.
   */
  it("never drops an event when the window is focused but the document is not", async () => {
    vi.stubGlobal("document", { hasFocus: () => false });
    show.mockResolvedValue(false); // main: "this window is focused"

    deliverPrNotifications(
      makePr({ reviewDecision: "REVIEW_REQUIRED" }),
      makePr({ reviewDecision: "CHANGES_REQUESTED" }),
      prefs,
    );
    await flush();

    expect(show).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("delivers nothing when the event's preference is off", async () => {
    show.mockResolvedValue(true);

    deliverPrNotifications(
      makePr({ commentCount: 1 }),
      makePr({ commentCount: 2 }),
      { ...prefs, notifyOnPrComment: false },
    );
    await flush();

    expect(show).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});

describe("deliverPrNotifications — comment author filters", () => {
  const show = vi.fn();
  const prefs = {
    notifyOnPrComment: true,
    notifyOnBotPrComments: false,
    notifyOnOwnPrComments: false,
    notifyOnPrApproved: true,
    notifyOnPrChangesRequested: true,
    notifyOnPrChecksFailed: true,
  } as unknown as AppPreferences;

  const comment = (over: Partial<PrComment> = {}): PrComment => ({
    author: "alice",
    body: "One nit.",
    url: "https://github.com/o/r/pull/123#issuecomment-9",
    createdAt: "2026-09-05T10:00:00Z",
    ...over,
  });

  beforeEach(() => {
    show.mockReset();
    show.mockResolvedValue(true);
    useToastStore.setState({ toasts: [] });
    const win = globalThis.window as unknown as Record<string, unknown>;
    const api = win.electronAPI as Record<string, unknown>;
    api.notifications = { ...(api.notifications as object), show };
    api.shell = { openExternal: vi.fn() };
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  const deliver = (
    latestComment: PrComment,
    overrides: Partial<AppPreferences> = {},
    next: Partial<PrInfo> = {},
  ) => {
    deliverPrNotifications(
      makePr({
        commentCount: 1,
        latestComment: comment({ createdAt: "2026-09-05T09:00:00Z" }),
      }),
      makePr({ commentCount: 2, latestComment, ...next }),
      { ...prefs, ...overrides },
    );
  };

  it("drops a bot comment while bot comments are off", async () => {
    deliver(comment({ author: "github-actions", isBot: true }));
    await flush();

    expect(show).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("delivers a bot comment once bot comments are on", async () => {
    deliver(comment({ author: "github-actions", isBot: true }), {
      notifyOnBotPrComments: true,
    });
    await flush();

    expect(show).toHaveBeenCalledTimes(1);
  });

  it("drops your own comment while own comments are off", async () => {
    deliver(comment({ author: "me", isViewer: true }));
    await flush();

    expect(show).not.toHaveBeenCalled();
  });

  it("delivers your own comment once own comments are on", async () => {
    deliver(comment({ author: "me", isViewer: true }), {
      notifyOnOwnPrComments: true,
    });
    await flush();

    expect(show).toHaveBeenCalledTimes(1);
  });

  it("still delivers a human comment", async () => {
    deliver(comment());
    await flush();

    expect(show).toHaveBeenCalledTimes(1);
  });

  /**
   * A bot landing last within one poll interval must not silence the human who
   * commented just before it.
   */
  it("notifies about the newest unfiltered comment when a bot commented last", async () => {
    const human = comment({
      body: "Looks good, one question.",
      url: "https://github.com/o/r/pull/123#issuecomment-10",
      createdAt: "2026-09-05T10:00:00Z",
    });
    const bot = comment({
      author: "github-actions",
      isBot: true,
      body: "Deployed to preview.",
      url: "https://github.com/o/r/pull/123#issuecomment-11",
      createdAt: "2026-09-05T10:01:00Z",
    });

    deliver(bot, {}, { recentComments: [bot, human] });
    await flush();

    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ url: human.url, comment: human }),
    );
  });

  it("ignores comments already seen at the baseline", async () => {
    const old = comment({
      body: "Older human comment.",
      url: "https://github.com/o/r/pull/123#issuecomment-1",
      createdAt: "2026-09-05T08:00:00Z",
    });
    const bot = comment({
      author: "github-actions",
      isBot: true,
      url: "https://github.com/o/r/pull/123#issuecomment-11",
      createdAt: "2026-09-05T10:01:00Z",
    });

    deliver(bot, {}, { recentComments: [bot, old] });
    await flush();

    expect(show).not.toHaveBeenCalled();
  });

  it("notifies when the author is unknown (payload predates author tagging)", async () => {
    deliverPrNotifications(
      makePr({ commentCount: 1 }),
      makePr({ commentCount: 2 }),
      prefs,
    );
    await flush();

    expect(show).toHaveBeenCalledTimes(1);
  });
});
