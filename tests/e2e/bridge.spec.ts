import { expect, type Page } from "@playwright/test";
import { SETTLE_MS } from "../../src/hooks/useTerminalResize";

import {
  assertVisiblePaneCount,
  bootWorkspaceWithTerminal,
  test,
} from "./fixtures";
import { Filmstrip } from "./helpers/filmstrip";
import {
  layout,
  postRoute,
  readSessionMeta,
  splitPane,
  tabIdForPane,
} from "./helpers/local-api";
import { activePaneId, awaitShellReady } from "./helpers/terminal";
import {
  clickMenuItem,
  closeRendererWindows,
  rendererWindowCount,
  reopenPrimaryWindow,
} from "./helpers/window";

/**
 * The desktop on the bridge (ADR-180).
 *
 * `web-app.spec.ts` is the browser's side of the same table; this file is the
 * half with no browser in it — two desktop *windows* on one pane, and the
 * control server with no window at all. Both are properties the desktop only
 * has because a renderer window is now an ordinary bridge connection: before
 * ADR-180 a window was the one caller `electron/ipc/` served directly, so
 * neither question had an answer to test.
 */

/** Every tab button of a window, in DOM order. */
function tabs(page: Page) {
  return page.locator('[data-testid="tab"]');
}

/**
 * The grid a pane is actually drawn at, read off the terminal itself.
 *
 * xterm renders into a WebGL canvas (see `tests/e2e/README.md`), so the grid
 * is not in the DOM. `window.__manorTerminals` is the seam the app exposes for
 * exactly this, and it is the same one `web-app.spec.ts` and
 * `claude-resize-duplication.spec.ts` read.
 */
async function paneGrid(
  page: Page,
  paneId: string,
): Promise<{ cols: number; rows: number }> {
  return page.evaluate((id) => {
    const handle = window.__manorTerminals?.get(id);
    if (!handle) throw new Error(`no terminal registered for ${id}`);
    return { cols: handle.term.cols, rows: handle.term.rows };
  }, paneId);
}

/**
 * Attach a window to a pane as a second viewer, at a grid of its own.
 *
 * This is the one call in the file that is not a click, and it is deliberate:
 * there is no UI that puts one pane in two desktop windows, because a claim is
 * exclusive (ADR-179 D4) — a popped-out tab leaves the primary's tab bar the
 * moment its window reports. So the second viewer is made the way a mounting
 * pane makes one: the exact `pty.create` `useTerminalConnection` issues, from
 * the second window's own page, over that window's own bridge connection. The
 * host cannot tell this apart from a `TerminalPane` mounting, which is the
 * point — dispatch appends the caller's identity itself (ADR-180 D6), so the
 * viewer this registers is that window and nothing else.
 */
function attachAsViewer(
  page: Page,
  paneId: string,
  cols: number,
  rows: number,
): Promise<{
  ok: boolean;
  winsizeOwner?: boolean;
  cols?: number;
  rows?: number;
}> {
  return page.evaluate(
    (args) =>
      window.electronAPI.pty.create(args.paneId, null, args.cols, args.rows),
    { paneId, cols, rows },
  );
}

test.describe("the desktop on the bridge (ADR-180)", () => {
  test.setTimeout(240_000);

  /**
   * ADR-180 D6's repair, which had no test: two desktop windows on one pane
   * stop fighting over its winsize.
   *
   * Before this slice `pty-attachments.ts` kept `{kind:"desktop"}` and
   * `{kind:"bridge"}` apart and any desktop viewer outranked any browser, so
   * two windows of the desktop were indistinguishable from each other: both
   * believed they owned the grid, and each resized the session to its own
   * measurement on every layout tick. Viewers are `{connectionId,
   * callerClass}` now, `local` outranks `device`, and among equals the most
   * recent attach wins — so the second window owns the winsize, the first
   * becomes an ordinary follower through the same code path a browser does,
   * and `pty.onWinsizeOwner` stops being a no-op subscription on the desktop.
   *
   * The second window asks for a grid *narrower* than the primary's on
   * purpose. A follower scales its glyphs down to fit a wider owner's grid
   * (ADR-177's floor), and a font left scaled would make the last assertion
   * here — the primary measuring for itself again once the other window is
   * gone — a measurement of the wrong font. Narrower keeps the primary's font
   * at its ceiling throughout, so the size it sends when it takes the pane
   * back is the size it sent when it opened it.
   */
  test("two desktop windows on one pane: the more recent attach owns the winsize, the other follows", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const film = new Filmstrip("bridge-two-windows");

    await bootWorkspaceWithTerminal(app, window, tempHome, "d6-two-windows");
    const paneId = await activePaneId(window);
    await awaitShellReady(window, tempHome, paneId);

    const desk = await readSessionMeta(request, tempHome, paneId);
    expect(desk.cols).not.toBeNull();
    expect(desk.rows).not.toBeNull();
    // Comfortably inside a real terminal's size, so the narrower grid below is
    // still a grid and not a rounding artefact.
    expect(desk.cols!).toBeGreaterThan(30);
    expect(desk.rows!).toBeGreaterThan(8);
    const cols = desk.cols! - 10;
    const rows = desk.rows! - 2;

    // A second window, made the way a user makes one: a tab popped out. What
    // it claims is a second tab — the pane below is not the one it draws, it
    // is the one it is about to also hold.
    await window.keyboard.press("Meta+t");
    await expect.poll(() => tabs(window).count(), { timeout: 30_000 }).toBe(2);
    const popup = await Promise.all([
      app.waitForEvent("window"),
      clickMenuItem(app, ["Window", "Move Tab to New Window"]),
    ]).then(([win]) => win);
    await popup.waitForLoadState("domcontentloaded");
    await expect.poll(() => tabs(window).count(), { timeout: 30_000 }).toBe(1);
    await assertVisiblePaneCount(window, 1);
    expect(await activePaneId(window)).toBe(paneId);
    await film.shot(window, "primary-owns-the-pane");

    const created = await attachAsViewer(popup, paneId, cols, rows);
    expect(created).toMatchObject({ ok: true, winsizeOwner: true, cols, rows });

    // The daemon agrees: the newcomer's grid is the session's grid.
    await expect
      .poll(
        async () => (await readSessionMeta(request, tempHome, paneId)).cols,
        { timeout: 20_000 },
      )
      .toBe(cols);

    // And the primary heard about it without having asked — a `pty.winsizeOwner`
    // frame is the only thing that could have put this badge on screen.
    const follower = window.getByTestId("terminal-follower");
    await expect(follower).toBeVisible({ timeout: 20_000 });
    await expect(follower).toHaveText(new RegExp(`${cols}×${rows}`));
    await expect
      .poll(() => paneGrid(window, paneId), { timeout: 20_000 })
      .toEqual({ cols, rows });
    await film.shot(window, "primary-follows-the-newcomer");

    // The half that is the actual repair: the follower does not take it back.
    // A fight would show up within one settle window, so several of them with
    // nothing happening is the assertion.
    await window.waitForTimeout(SETTLE_MS * 5);
    expect((await readSessionMeta(request, tempHome, paneId)).cols).toBe(cols);

    // The newcomer leaves: its connection dies with its window, which releases
    // every pane it held (`releaseViewer`), and the primary is the owner again
    // — it measures for itself and lands back on the size it opened with.
    await popup.close();
    await expect(follower).toHaveCount(0, { timeout: 20_000 });
    await expect
      .poll(
        async () => (await readSessionMeta(request, tempHome, paneId)).cols,
        { timeout: 20_000 },
      )
      .toBe(desk.cols);
    await film.shot(window, "primary-owns-it-again");
  });

  /**
   * The CLI with the window closed, and the window that comes back after it.
   *
   * Two halves of ADR-179 D5 meeting. A **structural**
   * command — `manor split-pane`, which is this POST — is the layout server's
   * to apply and needs no renderer at all, so it lands on a machine with
   * nothing on screen. An **addressed** one has to name a connection: an
   * `app-command` goes to the primary window's, a `menu-command` to the
   * focused window's, and with no window there is neither, which is the 503
   * below rather than a hang or a swallowed command.
   *
   * What is worth a test rather than a unit assertion is what happens next.
   * Both addressed paths resolve a *live* window to a *live* connection id
   * (`connectionIdForWindow`), so a window that was closed and reopened is a
   * different id under the same name — and a stale one would fail exactly
   * here, silently, as a command that lands nowhere.
   */
  test("the CLI lands with every window closed, and the window that comes back answers for it", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const film = new Filmstrip("bridge-no-window");

    await bootWorkspaceWithTerminal(app, window, tempHome, "cli-no-window");
    const paneId = await activePaneId(window);
    await awaitShellReady(window, tempHome, paneId);
    const tabId = await tabIdForPane(request, tempHome, paneId);
    await film.shot(window, "before-the-desk-closes");

    await closeRendererWindows(app);
    expect(await rendererWindowCount(app)).toBe(0);

    // Addressed, with nobody to address: "No Manor window is open".
    const focusClosed = await postRoute(
      request,
      tempHome,
      `/panes/${paneId}/focus`,
    );
    expect(focusClosed.status).toBe(503);

    // Structural, with nobody to address: applied anyway.
    const { paneId: splitPaneId } = await splitPane(request, tempHome, {
      paneId,
      direction: "vertical",
    });
    const snapshot = await layout(request, tempHome);
    const tab = snapshot.tabs.find((t) => t.tabId === tabId);
    expect(tab?.panes.map((p) => p.paneId)).toContain(splitPaneId);
    // Nothing reopened a window to do it.
    expect(await rendererWindowCount(app)).toBe(0);

    const reopened = await reopenPrimaryWindow(app);
    // The split the CLI made while there was no desk is simply what the desk
    // shows when it comes back: the renderer holds no layout of its own.
    await assertVisiblePaneCount(reopened, 2, 60_000);
    await film.shot(reopened, "the-desk-comes-back-split");

    // `app-command` → the primary window's connection, which is a connection
    // that did not exist when this workspace was opened.
    const focusOpen = await postRoute(
      request,
      tempHome,
      `/panes/${splitPaneId}/focus`,
    );
    expect(focusOpen.status).toBe(200);

    // `menu-command` → the focused window's connection, through the real
    // application menu.
    await expect
      .poll(() => tabs(reopened).count(), { timeout: 30_000 })
      .toBe(1);
    await clickMenuItem(app, ["File", "New Tab"]);
    await expect
      .poll(() => tabs(reopened).count(), { timeout: 30_000 })
      .toBe(2);
    await film.shot(reopened, "menu-command-landed");
  });
});
