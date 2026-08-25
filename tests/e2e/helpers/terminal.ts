import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { stripAnsi } from "./ansi";

/**
 * Driving and observing a terminal pane.
 *
 * xterm draws into a WebGL canvas, so there is nothing in the DOM to read: the
 * daemon's own scrollback file is the closest thing to "what the pane holds"
 * a test can look at directly.
 */

/** Read the daemon-side scrollback for a pane out of the test's temp HOME. */
export function scrollback(tempHome: string, paneId: string): string {
  const file = path.join(tempHome, ".manor/sessions", paneId, "scrollback.bin");
  if (!fs.existsSync(file)) return "";
  return stripAnsi(fs.readFileSync(file, "utf8"));
}

/**
 * How far the terminal's grid overflows the box it lives in, in pixels.
 *
 * The number that has to be <= 0. A grid is sized by dividing the box by one
 * measured cell, so anything that makes the measurement wrong — a font that
 * had not loaded, a fit read before the grid moved — shows up here as a pane
 * sitting taller than its container with its bottom rows clipped.
 */
export async function paneOverflowPx(window: Page): Promise<number | null> {
  return window.evaluate(() => {
    const pane = document.querySelector(
      '[data-testid="terminal-pane"]',
    ) as HTMLElement | null;
    const screen = pane?.querySelector(".xterm-screen") as HTMLElement | null;
    if (!pane || !screen) return null;
    return screen.offsetHeight - pane.clientHeight;
  });
}

/** The pane id of the first visible workspace pane. */
export async function activePaneId(window: Page): Promise<string> {
  const id = await window
    .locator('[data-testid="workspace-pane"]:visible')
    .first()
    .getAttribute("data-pane-id");
  expect(id).toBeTruthy();
  return id!;
}

/** Type a command into the focused terminal and submit it. */
export async function runInTerminal(
  window: Page,
  command: string,
): Promise<void> {
  await window.locator('[data-testid="terminal-pane"]:visible').first().click();
  await window.keyboard.type(command);
  await window.keyboard.press("Enter");
}

/**
 * Wait until the pane's shell is actually at a prompt.
 *
 * A freshly opened pane is visible before its shell has one, and zsh's line
 * editor discards anything typed while it is still initializing. Retyping is
 * not a fix — under load every retry can land inside that window, and a
 * retyped command would also inflate anything counting occurrences.
 *
 * So wait for the shell to actually settle: the session's scrollback starts
 * empty, fills as zsh sources its rc files and draws a prompt, and then stops.
 * A size that has held steady for two samples means it is done talking.
 */
export async function awaitShellReady(
  window: Page,
  tempHome: string,
  paneId: string,
): Promise<void> {
  let last = -1;
  let steady = 0;
  for (let attempt = 0; attempt < 100; attempt++) {
    await window.waitForTimeout(200);
    const size = scrollback(tempHome, paneId).length;
    steady = size > 0 && size === last ? steady + 1 : 0;
    last = size;
    if (steady >= 2) return;
  }
  throw new Error("shell never reached a prompt");
}
