import path from "path";
import type { Page } from "@playwright/test";
import {
  bootWorkspaceWithTerminal,
  createWorkspace,
  expect,
  test,
} from "./fixtures";
import {
  activePaneId,
  awaitShellReady,
  paneOverflowPx,
  runInTerminal,
  scrollback,
} from "./helpers/terminal";
import { dragWindowSize } from "./helpers/window";

/**
 * The bug these tests guard: a line the shell printed once shows up on screen
 * twice. Two known ways that happens — the daemon's warm-restore snapshot
 * replaying bytes xterm already has, and a PTY resize (SIGWINCH) making a
 * full-screen TUI repaint its frame into the scrollback.
 *
 * The oracle for "how many times is it on screen" is xterm's own search addon:
 * its n/m indicator counts matches in the live buffer, which is the only
 * renderer-side view of the terminal a test can read (WebGL draws to canvas,
 * so there are no row elements to query). It stops counting at 1000 matches,
 * so anything counted here stays well under that.
 */

/** A stand-in agent TUI: repaints a full-width frame in place. See the script. */
const FAKE_TUI = path.join(__dirname, "helpers/fake-tui.sh");

/**
 * Only the first line of the TUI's region carries the tag, so "on screen once"
 * is one match however tall the region happens to be. The region itself is most
 * of the screen — a short one cannot provoke the cursor-up clamp that strands a
 * copy when the grid holds fewer rows than the pty does.
 */
const TUI_FRAME_ROWS = 1;

/** Run `command` exactly once and wait for `marker` to reach the scrollback. */
async function runOnce(
  window: Page,
  tempHome: string,
  paneId: string,
  command: string,
  marker: string,
): Promise<void> {
  await runInTerminal(window, command);
  await expect
    .poll(() => scrollback(tempHome, paneId).includes(marker), {
      timeout: 30_000,
    })
    .toBe(true);
}

/** Matches for `needle` in the visible terminal's buffer, via Cmd+F's n/m readout. */
async function onScreenMatches(window: Page, needle: string): Promise<number> {
  await window.locator('[data-testid="terminal-pane"]:visible').first().click();
  await window.keyboard.press("Meta+f");
  const input = window.getByPlaceholder("Search terminal");
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.fill(needle);
  const count = window.locator('[class*="searchBarCount"]');
  await expect(count).toBeVisible({ timeout: 5_000 });
  // The indicator reads "<index>/<total>".
  const text = (await count.textContent()) ?? "";
  await window.keyboard.press("Escape");
  const total = Number(text.split("/")[1]?.trim() ?? "0");
  return Number.isFinite(total) ? total : 0;
}

/**
 * Print MARKER once. The command text itself must not contain the marker
 * literally, or the echoed command line counts as a second match on screen.
 */
const MARKER = "ZQMARKERUNIQUE";
const PRINT_MARKER = `printf 'ZQMARKER%s\\n' UNIQUE`;

test("a line printed once stays on screen once across a renderer reload", async ({
  app,
  window,
  tempHome,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-dup");
  const paneId = await activePaneId(window);

  await awaitShellReady(window, tempHome, paneId);
  await runOnce(window, tempHome, paneId, PRINT_MARKER, MARKER);

  await expect
    .poll(() => onScreenMatches(window, MARKER), { timeout: 15_000 })
    .toBe(1);

  // Reload the renderer: panes remount and re-attach to the still-running
  // daemon session, which replies with a warm-restore snapshot.
  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  await expect(
    window.locator('[data-testid="terminal-pane"]:visible').first(),
  ).toBeVisible({ timeout: 30_000 });

  await expect
    .poll(() => onScreenMatches(window, MARKER), { timeout: 15_000 })
    .toBe(1);
});

test("switching workspaces never resizes a terminal's PTY", async ({
  app,
  window,
  tempHome,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-winch");
  const paneId = await activePaneId(window);

  // The shell reports every SIGWINCH it receives. A workspace switch that
  // changes a terminal's pixel box shows up here.
  await awaitShellReady(window, tempHome, paneId);
  await runOnce(
    window,
    tempHome,
    paneId,
    `trap 'printf "GOTWIN%s\\n" CH' WINCH; printf 'TRAP%s\\n' READY`,
    "TRAPREADY",
  );

  await createWorkspace(window, "ws-winch-other");
  await window.keyboard.press("Meta+t");
  await expect(
    window.locator('[data-testid="terminal-pane"]:visible'),
  ).toHaveCount(1, { timeout: 30_000 });

  for (let i = 0; i < 3; i++) {
    for (const name of ["ws-winch", "ws-winch-other"]) {
      await window
        .locator('[data-testid="workspace-item"]', { hasText: name })
        .first()
        .click();
      await expect(
        window.locator('[data-testid="workspace-pane"]:visible'),
      ).toHaveCount(1, { timeout: 10_000 });
    }
  }

  const winches = scrollback(tempHome, paneId).match(/GOTWINCH/g) ?? [];
  expect(winches).toHaveLength(0);
});

/**
 * Controls. Both assertions above are "nothing happened" assertions, which pass
 * for free if the instrument is broken — so each instrument gets a test that
 * makes the thing happen on purpose and checks it registers.
 */

test("control: the search oracle counts a genuinely repeated line twice", async ({
  app,
  window,
  tempHome,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-control-search");
  const paneId = await activePaneId(window);

  await awaitShellReady(window, tempHome, paneId);
  await runOnce(
    window,
    tempHome,
    paneId,
    `${PRINT_MARKER}; ${PRINT_MARKER}`,
    MARKER,
  );

  await expect
    .poll(() => onScreenMatches(window, MARKER), { timeout: 15_000 })
    .toBe(2);
});

test("control: the SIGWINCH tripwire fires on a real resize", async ({
  app,
  window,
  tempHome,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-control-winch");
  const paneId = await activePaneId(window);

  await awaitShellReady(window, tempHome, paneId);
  await runOnce(
    window,
    tempHome,
    paneId,
    `trap 'printf "GOTWIN%s\\n" CH' WINCH; printf 'TRAP%s\\n' READY`,
    "TRAPREADY",
  );

  // Splitting the pane genuinely halves its box — the PTY must be resized.
  // The resulting fit lands ~3s later (same on main), hence the wide timeout.
  await window.keyboard.press("Meta+d");
  await expect(
    window.locator('[data-testid="workspace-pane"]:visible'),
  ).toHaveCount(2, { timeout: 10_000 });

  await expect
    .poll(
      () => (scrollback(tempHome, paneId).match(/GOTWINCH/g) ?? []).length,
      {
        timeout: 45_000,
      },
    )
    .toBeGreaterThan(0);
});

test("a remounted terminal attaches at the size it settles on", async ({
  app,
  window,
  tempHome,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-remount");
  const paneId = await activePaneId(window);

  await awaitShellReady(window, tempHome, paneId);
  await runOnce(
    window,
    tempHome,
    paneId,
    `trap 'printf "GOTWIN%s\\n" CH' WINCH; printf 'TRAP%s\\n' READY`,
    "TRAPREADY",
  );

  // A reload remounts every pane while the window is still laying itself out —
  // the same moment an app launch restores panes. Measuring the terminal before
  // that settles attaches the PTY at the wrong size and corrects it a beat
  // later, and the correcting SIGWINCH is what makes a TUI reprint its frame.
  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  await expect(
    window.locator('[data-testid="terminal-pane"]:visible').first(),
  ).toBeVisible({ timeout: 30_000 });
  await window.waitForTimeout(3_000);

  const winches = scrollback(tempHome, paneId).match(/GOTWINCH/g) ?? [];
  expect(winches).toHaveLength(0);
});

/**
 * The bug: drag a window edge for a few seconds with an agent running, and the
 * agent's frame is left behind on the screen over and over, until the
 * scrollback is mostly copies of it.
 *
 * It is a disagreement about one number. The emulator's grid resizes in the
 * renderer; the pty's winsize is three hops away. While the grid is narrower
 * than the width the program is drawing for, every full-width line it draws
 * wraps, so the frame it repaints in place spans more rows than its cursor-up
 * moves back over — and the copy it meant to overwrite is stranded above it.
 * Once per repaint, for as long as the two numbers disagree.
 *
 * `fake-tui.sh` is the program: it draws a frame the width of the terminal and
 * repaints it in place, re-measuring on SIGWINCH the way a real harness does.
 * A plain stream of output does not show this — nothing that is printed once
 * and never redrawn can be stranded — which is why the shell alone was not
 * enough to reproduce it.
 */
test("a repainting agent frame stays on screen once across a long resize", async ({
  app,
  window,
  tempHome,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-resize-tui");
  const paneId = await activePaneId(window);

  await awaitShellReady(window, tempHome, paneId);
  await runOnce(window, tempHome, paneId, `sh ${FAKE_TUI}`, "TUIREADY");
  await expect
    .poll(() => onScreenMatches(window, "ZQFRAME"), { timeout: 15_000 })
    .toBe(TUI_FRAME_ROWS);

  // Two regimes, because they stress different halves of the fix. A fast sweep
  // is one settled size change at the end; a slow one settles on every step, so
  // the pty is told a new width over and over with a streaming program on it.
  await dragWindowSize(app, 60, 16);
  await dragWindowSize(app, 20, 220);
  await window.waitForTimeout(2_000);

  await expect
    .poll(() => onScreenMatches(window, "ZQFRAME"), { timeout: 15_000 })
    .toBe(TUI_FRAME_ROWS);
});

/**
 * The grid grows toward the container on its own but only ever shrinks through
 * the handoff, so a fit read a moment too early is not self-correcting the way
 * it used to be — it sticks, and the pane sits taller than the box it lives in
 * for good, with its bottom rows clipped. That is not visible to the search
 * oracle, because those rows are in the buffer either way; it is only visible
 * in the geometry. xterm re-measures its cell metrics after a resize, which is
 * exactly how a stale fit gets read, so this is a live risk and not a
 * theoretical one: it regressed once already and cost three rows.
 */
test("a pane ends a resize fitting its container, not overflowing it", async ({
  app,
  window,
  tempHome,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-fit");
  const paneId = await activePaneId(window);
  await awaitShellReady(window, tempHome, paneId);
  await runOnce(window, tempHome, paneId, `sh ${FAKE_TUI}`, "TUIREADY");

  const overflowPx = () => paneOverflowPx(window);

  await expect.poll(overflowPx, { timeout: 15_000 }).toBeLessThanOrEqual(0);

  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const [width, height] = win.getSize();
    win.setSize(width - 120, height - 260);
  });

  // Shrinking holds the old rows until the handoff completes — that transient
  // is the deliberate trade. What must not happen is it staying that way.
  await expect.poll(overflowPx, { timeout: 15_000 }).toBeLessThanOrEqual(0);
});

/**
 * Control. The assertion above passes for free if the window never actually
 * resized, or if the resize never reached the pty — so make the pty say it did.
 */
test("control: dragging the window edge reaches the PTY", async ({
  app,
  window,
  tempHome,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-resize-control");
  const paneId = await activePaneId(window);

  await awaitShellReady(window, tempHome, paneId);
  await runOnce(
    window,
    tempHome,
    paneId,
    `trap 'printf "GOTWIN%s\\n" CH' WINCH; printf 'TRAP%s\\n' READY`,
    "TRAPREADY",
  );

  // Each step must outlast the settle window, or the whole sweep coalesces
  // into the one size it ends on — and it ends where it started, so a faster
  // drag correctly reaches the pty with nothing to say. That is the design,
  // not the thing under test here: this asks whether a drag reaches the pty
  // at all, so it has to be a drag that has something to deliver.
  await dragWindowSize(app, 12, 600);

  await expect
    .poll(() => (scrollback(tempHome, paneId).match(/GOTWINCH/g) ?? []).length, {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
});
