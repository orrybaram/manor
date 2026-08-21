import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";
import { bootWorkspaceWithTerminal, createWorkspace, expect, test } from "./fixtures";

/**
 * The bug these tests guard: a line the shell printed once shows up on screen
 * twice. Two known ways that happens — the daemon's warm-restore snapshot
 * replaying bytes xterm already has, and a PTY resize (SIGWINCH) making a
 * full-screen TUI repaint its frame into the scrollback.
 *
 * The oracle for "how many times is it on screen" is xterm's own search addon:
 * its n/m indicator counts matches in the live buffer, which is the only
 * renderer-side view of the terminal a test can read (WebGL draws to canvas,
 * so there are no row elements to query).
 */

/** Read the daemon-side scrollback for a pane out of the test's temp HOME. */
function scrollback(tempHome: string, paneId: string): string {
  const file = path.join(tempHome, ".manor/sessions", paneId, "scrollback.bin");
  if (!fs.existsSync(file)) return "";
   
  return fs.readFileSync(file, "utf8").replace(/\[[0-9;?]*[a-zA-Z]/g, "");
}

async function activePaneId(window: Page): Promise<string> {
  const id = await window
    .locator('[data-testid="workspace-pane"]:visible')
    .first()
    .getAttribute("data-pane-id");
  expect(id).toBeTruthy();
  return id!;
}

/** Type a command into the focused terminal and submit it. */
async function runInTerminal(window: Page, command: string): Promise<void> {
  await window.locator('[data-testid="terminal-pane"]:visible').first().click();
  await window.keyboard.type(command);
  await window.keyboard.press("Enter");
}

/**
 * Wait until the pane's shell is actually at a prompt.
 *
 * A freshly opened pane is visible before its shell has one, and zsh's line
 * editor discards anything typed while it is still initializing — so a probe
 * gets retyped until it echoes back. Retrying a *probe* rather than the real
 * command matters: the tests below count how many times a line appears, and a
 * retyped command would inflate that count.
 */
async function awaitShellReady(
  window: Page,
  tempHome: string,
  paneId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await runInTerminal(window, `printf 'SHELL%s\\n' UP`);
    try {
      await expect
        .poll(() => scrollback(tempHome, paneId).includes("SHELLUP"), {
          timeout: 6_000,
        })
        .toBe(true);
      return;
    } catch {
      // Swallowed by an un-initialized ZLE — probe again.
    }
  }
  throw new Error("shell never reached a prompt");
}

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
    .poll(() => (scrollback(tempHome, paneId).match(/GOTWINCH/g) ?? []).length, {
      timeout: 45_000,
    })
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
