import type { ElectronApplication } from "@playwright/test";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";
import {
  activePaneId,
  awaitShellReady,
  runInTerminal,
  scrollback,
} from "./helpers/terminal";

/**
 * The bug: after resizing the window, the pane stops responding — nothing typed
 * reaches the shell, and nothing the shell prints reaches the screen.
 *
 * Two separate failures wear the same face, so this asks about both halves
 * separately: the daemon's scrollback says whether input still reaches the pty,
 * and xterm's search oracle says whether output still reaches the renderer.
 */

/** Matches for `needle` in the visible terminal's buffer, via Cmd+F's n/m readout. */
async function onScreenMatches(
  window: import("@playwright/test").Page,
  needle: string,
): Promise<number> {
  await window.locator('[data-testid="terminal-pane"]:visible').first().click();
  await window.keyboard.press("Meta+f");
  const input = window.getByPlaceholder("Search terminal");
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.fill(needle);
  const count = window.locator('[class*="searchBarCount"]');
  await expect(count).toBeVisible({ timeout: 5_000 });
  const text = (await count.textContent()) ?? "";
  await window.keyboard.press("Escape");
  const total = Number(text.split("/")[1]?.trim() ?? "0");
  return Number.isFinite(total) ? total : 0;
}

async function resizeWindow(
  app: ElectronApplication,
  dw: number,
  dh: number,
): Promise<void> {
  await app.evaluate(
    async ({ BrowserWindow }, d) => {
      const win = BrowserWindow.getAllWindows()[0];
      const [width, height] = win.getSize();
      win.setSize(width + d.dw, height + d.dh);
    },
    { dw, dh },
  );
}

test("a terminal still takes input and paints output after a window resize", async ({
  app,
  window,
  tempHome,
}) => {
  // The original failure threw in the renderer and swallowed every later byte,
  // so an uncaught error here is itself the bug, ahead of any assertion.
  const pageErrors: string[] = [];
  window.on("pageerror", (e) => pageErrors.push(e.message));

  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-lockup");
  const paneId = await activePaneId(window);
  await awaitShellReady(window, tempHome, paneId);

  // Baseline: the pane works before the resize.
  await runInTerminal(window, `printf 'BEFORE%s\\n' TAG`);
  await expect
    .poll(() => scrollback(tempHome, paneId).includes("BEFORETAG"), {
      timeout: 15_000,
    })
    .toBe(true);
  await expect
    .poll(() => onScreenMatches(window, "BEFORETAG"), { timeout: 15_000 })
    .toBeGreaterThan(0);

  await resizeWindow(app, -180, -140);
  // Past the 400ms settle window plus the daemon round trip.
  await window.waitForTimeout(3_000);

  await runInTerminal(window, `printf 'AFTER%s\\n' TAG`);

  // Half one: did the keystrokes reach the pty at all?
  await expect
    .poll(() => scrollback(tempHome, paneId).includes("AFTERTAG"), {
      timeout: 15_000,
    })
    .toBe(true);

  // Half two: did the pty's answer reach the screen?
  await expect
    .poll(() => onScreenMatches(window, "AFTERTAG"), { timeout: 15_000 })
    .toBeGreaterThan(0);

  expect(pageErrors).toEqual([]);
});
