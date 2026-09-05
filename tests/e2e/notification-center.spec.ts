import fs from "fs";
import path from "path";
import { type ElectronApplication, type Page } from "@playwright/test";

import {
  createWorkspace,
  expect,
  importSeededProject,
  killApp,
  launchApp,
  openTerminalTab,
  test,
} from "./fixtures";
import { FAKE_AGENT } from "./helpers/fake-agent";
import { Filmstrip } from "./helpers/filmstrip";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";

/**
 * ADR-162 end to end: what the app remembers about a notification, and what
 * the bell in the sidebar does with it.
 *
 * The claim under test is not "a banner appears" — a test cannot see an OS
 * banner, and the Electron window is focused for the whole run, which is
 * precisely when Manor suppresses one. That is the point. Everything here
 * asserts on the case the feature exists for: the notification nobody saw is
 * still recorded, still readable, and still leads somewhere.
 *
 * Nothing reaches into main to fabricate a record. Agent notifications come
 * from an agent reporting its own lifecycle over the hook endpoint; the PR
 * notification comes from the same `notifications.show` call the PR watcher
 * makes in the renderer.
 */

/** Where main persists the log — mirrors `notificationsFile()` in paths.ts. */
function notificationsFile(tempHome: string): string {
  const dataDir =
    process.platform === "darwin"
      ? path.join(tempHome, "Library", "Application Support", "Manor")
      : path.join(tempHome, ".local", "share", "Manor");
  return path.join(dataDir, "notifications.json");
}

function readPersistedTitles(tempHome: string): string[] {
  const file = notificationsFile(tempHome);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      notifications?: { title: string }[];
    };
    return (parsed.notifications ?? []).map((n) => n.title);
  } catch {
    // A read that lands mid-write sees half a file; the poll will come back.
    return [];
  }
}

const bell = (window: Page) => window.getByTestId("notifications-bell");
const popover = (window: Page) => window.getByTestId("notifications-popover");
const rows = (window: Page) => window.getByTestId("notification-row");
/** The kind filter. Scoped: "All" also substring-matches "Mark all read". */
const filterBar = (window: Page) => window.getByTestId("notifications-filter");

async function openBell(window: Page): Promise<void> {
  await bell(window).click();
  await expect(popover(window)).toBeVisible({ timeout: 5_000 });
}

async function closeBell(window: Page): Promise<void> {
  await window.keyboard.press("Escape");
  await expect(popover(window)).not.toBeVisible({ timeout: 5_000 });
}

/**
 * Ask main to notify, exactly as `usePrWatcher` → `notifyPrEvent` does.
 *
 * Resolves to whether a banner was presented. In a test it is always `false` —
 * the window is focused — which is the interesting half: the record must exist
 * anyway.
 */
function showPrNotification(
  window: Page,
  payload: {
    kind: string;
    title: string;
    body: string;
    url?: string;
    comment?: { author: string; body: string; url: string; createdAt: string };
  },
): Promise<boolean> {
  return window.evaluate(
    (p) =>
      window.electronAPI.notifications.show(
        p as Parameters<typeof window.electronAPI.notifications.show>[0],
      ),
    payload,
  );
}

/**
 * Put the window in the state the feature is about: focused, which is when
 * main suppresses the banner. Focus is otherwise at the mercy of whatever
 * else the machine running the suite has on screen.
 */
async function focusMainWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.show();
    win?.focus();
  });
}

/** Record every url main is asked to open, so a row click can be witnessed. */
async function captureExternalOpens(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as unknown as { __openedUrls: string[] }).__openedUrls = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
}

function openedUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () => (globalThis as unknown as { __openedUrls?: string[] }).__openedUrls ?? [],
  );
}

test.describe("notification center", () => {
  test.setTimeout(180_000);

  test("a suppressed notification is still recorded, readable, and clickable", async ({
    app,
    window,
    tempHome,
  }) => {
    const film = new Filmstrip("notification-center");
    await captureExternalOpens(app);
    // The sidebar — and so the bell — only exists once a project does.
    await importSeededProject(app, window, tempHome);

    // The bell is there before anything has happened, and says nothing.
    await expect(bell(window)).toBeVisible({ timeout: 30_000 });
    await expect(window.getByTestId("notifications-badge")).toHaveCount(0);
    await openBell(window);
    await expect(window.getByTestId("notifications-empty")).toBeVisible();
    await film.shot(window, "bell-empty");
    await closeBell(window);

    const url = "https://example.test/o/r/pull/7";
    await focusMainWindow(app);
    const presented = await showPrNotification(window, {
      // The PR event kind the watcher emits; main maps it to a record kind.
      kind: "approved",
      title: "PR #7 approved",
      body: "Add the notification center",
      url,
    });
    // Focused window: main declined to show a banner. The whole feature is
    // about what happens to the event now.
    expect(presented).toBe(false);

    // Presence, not a count — the badge says "something happened", the list
    // behind it says what.
    await expect(window.getByTestId("notifications-badge")).toBeVisible({
      timeout: 10_000,
    });

    await openBell(window);
    await expect(rows(window)).toHaveCount(1);
    const row = rows(window).first();
    await expect(row).toHaveAttribute("data-kind", "pr-approved");
    await expect(row).toHaveAttribute("data-read", "false");
    await expect(row).toContainText("PR #7 approved");
    await expect(row).toContainText("Add the notification center");
    // Grouped by day, through the same bucketing the task list uses.
    await expect(popover(window)).toContainText("Today");
    await film.shot(window, "bell-unread-row");

    // A click goes wherever the banner would have gone.
    await row.click();
    await expect(popover(window)).not.toBeVisible({ timeout: 5_000 });
    await expect.poll(() => openedUrls(app), { timeout: 10_000 }).toContain(url);

    // Clicking read it, and main — not the renderer — is what says so.
    await expect(window.getByTestId("notifications-badge")).toHaveCount(0);
    await openBell(window);
    await expect(rows(window).first()).toHaveAttribute("data-read", "true");
    await film.shot(window, "bell-row-read");
    await closeBell(window);
  });

  test("mark all read and clear go through main", async ({ app, window, tempHome }) => {
    await captureExternalOpens(app);
    await importSeededProject(app, window, tempHome);
    await expect(bell(window)).toBeVisible({ timeout: 30_000 });

    for (const n of [1, 2, 3]) {
      await showPrNotification(window, {
        kind: "comment",
        title: `PR #${n} — new comment`,
        body: "Add the notification center",
        url: `https://example.test/o/r/pull/${n}`,
      });
    }

    await expect(window.getByTestId("notifications-badge")).toBeVisible({
      timeout: 10_000,
    });

    await openBell(window);
    await expect(rows(window)).toHaveCount(3);
    // Newest first, as main sends them.
    await expect(rows(window).first()).toContainText("PR #3");

    // The type filter is a view over the same list — "Agents" hides these PR
    // records, "All" restores them, and nothing is mutated on the way.
    await filterBar(window).getByRole("button", { name: "Agents" }).click();
    await expect(rows(window)).toHaveCount(0);
    await filterBar(window).getByRole("button", { name: "All" }).click();
    await expect(rows(window)).toHaveCount(3);

    await popover(window).getByRole("button", { name: "Mark all read" }).click();
    await expect(window.getByTestId("notifications-badge")).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(rows(window).nth(0)).toHaveAttribute("data-read", "true");
    await expect(rows(window).nth(1)).toHaveAttribute("data-read", "true");
    await expect(rows(window).nth(2)).toHaveAttribute("data-read", "true");

    await popover(window).getByRole("button", { name: "Clear" }).click();
    await expect(rows(window)).toHaveCount(0, { timeout: 10_000 });
    await expect(window.getByTestId("notifications-empty")).toBeVisible();

    // Cleared in main, not just in the view.
    await expect
      .poll(() => readPersistedTitles(tempHome), { timeout: 10_000 })
      .toEqual([]);
  });

  test("resting on a comment row opens the comment beside the list", async ({
    app,
    window,
    tempHome,
  }) => {
    const film = new Filmstrip("notification-comment-preview");
    await captureExternalOpens(app);
    await importSeededProject(app, window, tempHome);
    await expect(bell(window)).toBeVisible({ timeout: 30_000 });

    const comment = {
      author: "alice",
      body: "Nit: this helper already exists in relative-time.ts.\n\nOtherwise LGTM.",
      url: "https://example.test/o/r/pull/9#issuecomment-42",
      createdAt: new Date().toISOString(),
    };
    await showPrNotification(window, {
      kind: "comment",
      title: "PR #9 — new comment",
      body: "Expand PR comment in notifications",
      url: comment.url,
      comment,
    });

    await openBell(window);
    await expect(rows(window)).toHaveCount(1);
    const preview = window.getByTestId("notification-comment");

    // Hover intent, not hover: a pass over the row shows nothing.
    await rows(window).first().hover();
    await expect(preview).toHaveCount(0);
    await window.mouse.move(0, 0);

    // Resting on it does. The row itself is unchanged.
    await rows(window).first().hover();
    await expect(preview).toBeVisible({ timeout: 5_000 });
    await expect(preview).toContainText("@alice");
    await expect(preview).toContainText("Nit: this helper already exists");
    await expect(rows(window).first()).not.toContainText("Nit:");
    await film.shot(window, "comment-preview-open");

    // Leaving both the row and the preview closes it.
    await window.mouse.move(0, 0);
    await expect(preview).toHaveCount(0, { timeout: 5_000 });

    // A click still goes to the comment, not the top of the PR.
    await rows(window).first().click();
    await expect(popover(window)).not.toBeVisible({ timeout: 5_000 });
    await expect
      .poll(() => openedUrls(app), { timeout: 10_000 })
      .toContain(comment.url);
  });

  /**
   * Launches its own app instances rather than taking the fixture's: the
   * fixture owns the shutdown of the app it created, and killing that one
   * mid-test leaves its teardown holding a disposed handle.
   */
  test("the log survives a restart", async ({ tempHome }) => {
    const first = await launchApp(tempHome);
    try {
      const window = await first.firstWindow();
      await window.waitForLoadState("domcontentloaded");
      await importSeededProject(first, window, tempHome);
      await expect(bell(window)).toBeVisible({ timeout: 30_000 });

      await showPrNotification(window, {
        kind: "checks-failed",
        title: "PR #12 — CI checks failing",
        body: "Persisted across a restart",
        url: "https://example.test/o/r/pull/12",
      });

      // Writes are debounced; wait for the record to actually be on disk
      // rather than killing the app mid-timer and testing nothing.
      await expect
        .poll(() => readPersistedTitles(tempHome), { timeout: 15_000 })
        .toContain("PR #12 — CI checks failing");
    } finally {
      await killApp(first);
    }

    const relaunched = await launchApp(tempHome);
    try {
      const window = await relaunched.firstWindow();
      await window.waitForLoadState("domcontentloaded");

      await expect(bell(window)).toBeVisible({ timeout: 30_000 });
      // Unread state survives too — a missed notification stays missed.
      await expect(window.getByTestId("notifications-badge")).toBeVisible({
        timeout: 15_000,
      });
      await openBell(window);
      await expect(rows(window)).toHaveCount(1);
      await expect(rows(window).first()).toContainText(
        "PR #12 — CI checks failing",
      );
    } finally {
      await killApp(relaunched);
    }
  });

  /**
   * The agent path, end to end: a hook event moves a task's status, main
   * records what it would have banner-ed, and the row shows up under the bell.
   *
   * The fake agent parks in `requires_input` on startup, which is the case the
   * relay's `CreateTask` effect owns — no prior task exists for
   * `UpdateTaskActiveStatus` to find — and then answers each message with a
   * Stop. Both kinds of transition have to reach the log.
   */
  test("an agent's status changes land in the log while the window is focused", async ({
    app,
    window,
    tempHome,
  }) => {
    await importSeededProject(app, window, tempHome);
    await createWorkspace(window, "notifications-e2e");
    await openTerminalTab(window);

    await awaitShellReady(window, tempHome, await activePaneId(window));
    // Typed rather than launched with Cmd+N: that consumes the prewarmed
    // session, whose task row has no pane and no project. See the e2e README.
    await runInTerminal(window, `"${FAKE_AGENT}" notif-agent`);
    await expect(bell(window)).toBeVisible();

    // The agent parks needing input before anything else happens. Focused
    // window, so no banner — the record is the only trace, which is the point.
    await expect
      .poll(() => readPersistedTitles(tempHome), { timeout: 90_000 })
      .toEqual(["Agent needs input"]);

    // Answer it. The reply is a Stop the relay turns into `responded`.
    //
    // (The agent parks again straight after, but the relay drops a re-park
    // that arrives while the session is already `responded` — ADR-139's
    // late-active guard. No banner for it, so no record either.)
    await runInTerminal(window, "hello");
    await expect
      .poll(() => readPersistedTitles(tempHome), { timeout: 90_000 })
      .toEqual(["Agent responded", "Agent needs input"]);

    await runInTerminal(window, "again");
    // Two turns, two `responded` records. The unseen bit this sits alongside
    // collapses a round trip into a single flag; the whole point of a log is
    // that it does not.
    await expect
      .poll(() => readPersistedTitles(tempHome), { timeout: 90_000 })
      .toEqual(["Agent responded", "Agent responded", "Agent needs input"]);

    // The agent's own pane is the one on screen the whole time. Logging it is
    // the point; badging it is not — the user is watching that session, so
    // main reads those records as the pane is marked seen and the bell stays
    // quiet.
    await expect(window.getByTestId("notifications-badge")).toHaveCount(0, {
      timeout: 15_000,
    });
    await openBell(window);

    await expect(rows(window)).toHaveCount(3);
    const respondedRow = rows(window).first();
    await expect(respondedRow).toHaveAttribute("data-kind", "agent-responded");
    await expect(respondedRow).toHaveAttribute("data-read", "true");
    await expect(respondedRow).toContainText("Agent responded");
    // The body names the task and its project, exactly as the banner would.
    await expect(respondedRow).toContainText("notif-agent");
    await expect(respondedRow).toContainText("test-project");

    const inputRow = rows(window).last();
    await expect(inputRow).toHaveAttribute("data-kind", "agent-requires-input");
    await expect(inputRow).toContainText("Agent needs input");

    // Filtering is by family: these are all agent records, so "PRs" empties
    // the list and "Agents" brings every one of them back.
    await filterBar(window).getByRole("button", { name: "PRs" }).click();
    await expect(rows(window)).toHaveCount(0);
    await expect(window.getByTestId("notifications-empty")).toBeVisible();
    await filterBar(window).getByRole("button", { name: "Agents" }).click();
    await expect(rows(window)).toHaveCount(3);

    await closeBell(window);
  });
});
