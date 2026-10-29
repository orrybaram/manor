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

/**
 * A pane's whole grid, read off the terminal itself (xterm draws into a
 * canvas) through `window.__manorTerminals` — on the desktop or in the web
 * app, which runs the identical component.
 */
export async function paneText(page: Page, paneId: string): Promise<string> {
  return page.evaluate((id) => {
    const handle = window.__manorTerminals?.get(id);
    if (!handle) throw new Error(`no terminal registered for ${id}`);
    return handle.serialize({ scrollback: 20_000 });
  }, paneId);
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

/**
 * Paste an image into a pane the way a browser does: a synthetic `paste`
 * ClipboardEvent whose DataTransfer holds one image File, dispatched on the
 * pane's xterm textarea (where a real paste lands). Bytes cross `evaluate` as
 * base64.
 */
export async function pasteImageIntoPane(
  page: Page,
  paneId: string,
  bytes: Uint8Array,
  type: string,
): Promise<void> {
  const base64 = Buffer.from(bytes).toString("base64");
  await page.evaluate(
    ({ id, b64, mime }) => {
      const handle = window.__manorTerminals?.get(id);
      if (!handle) throw new Error(`no terminal registered for ${id}`);
      const textarea = handle.term.textarea;
      if (!textarea) throw new Error(`pane ${id} has no xterm textarea`);
      const raw = atob(b64);
      const data = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
      const file = new File([data], "shot.png", { type: mime });
      const dt = new DataTransfer();
      dt.items.add(file);
      textarea.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { id: paneId, b64: base64, mime: type },
  );
}

/**
 * Move the pointer onto the last place `text` is printed in the pane and
 * return where it is. The last, because the command that printed it echoed
 * it first.
 */
async function hoverText(window: Page, paneId: string, text: string): Promise<{ x: number; y: number }> {
  const pos = await window.evaluate(
    ({ id, needle }) => {
      const term = window.__manorTerminals!.get(id)!.term;
      const buf = term.buffer.active;
      for (let y = buf.length - 1; y >= 0; y--) {
        const line = buf.getLine(y)?.translateToString(true) ?? "";
        const x = line.lastIndexOf(needle);
        if (x < 0) continue;
        const screen = term.element!.querySelector(".xterm-screen")!.getBoundingClientRect();
        const cellW = screen.width / term.cols;
        const cellH = screen.height / term.rows;
        return {
          x: screen.left + (x + 2.5) * cellW,
          y: screen.top + (y - buf.viewportY + 0.5) * cellH,
        };
      }
      throw new Error(`"${needle}" is not in the pane`);
    },
    { id: paneId, needle: text },
  );
  // Two moves: xterm finds links on mousemove, so arrive rather than appear.
  await window.mouse.move(pos.x - 8, pos.y);
  await window.mouse.move(pos.x, pos.y);
  await window.waitForTimeout(300);
  return pos;
}

/** Right-click the last place `text` is printed in the pane (see `hoverText`). */
export async function rightClickText(window: Page, paneId: string, text: string): Promise<void> {
  const pos = await hoverText(window, paneId, text);
  await window.mouse.click(pos.x, pos.y, { button: "right" });
  await expect(window.locator('[role="menu"]')).toBeVisible();
}

/** Cmd/Ctrl+click the last place `text` is printed in the pane: a link's activation. */
export async function modifierClickText(window: Page, paneId: string, text: string): Promise<void> {
  const pos = await hoverText(window, paneId, text);
  await window.keyboard.down("ControlOrMeta");
  try {
    await window.mouse.click(pos.x, pos.y);
  } finally {
    await window.keyboard.up("ControlOrMeta");
  }
}
