import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";
import { bootWorkspaceWithTerminal, openTerminalTab, test, expect } from "./fixtures";
import { activePaneId, awaitShellReady, scrollback } from "./helpers/terminal";

/**
 * A pane off screen holds its output (`src/lib/held-output.ts`) and catches
 * up when shown, typed into, or asked a terminal query.
 *
 * Commands reach the hidden pane through `pty.write`, as an automation's
 * typing would: there is no way to type into a pane nobody can see. The
 * daemon's scrollback file says when the output has been produced; the
 * pane's own xterm says whether it was written.
 */

const SHOTS = process.env.MANOR_SHOTS_DIR;

async function shot(window: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await window.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** Type into `paneId`'s pty without touching the UI. */
async function ptyType(window: Page, paneId: string, text: string): Promise<void> {
  await window.evaluate(([id, t]) => window.electronAPI.pty.write(id, t), [paneId, text] as const);
}

/** The pane's grid as xterm has it, without catching up first. */
async function written(window: Page, paneId: string): Promise<string> {
  return window.evaluate((id) => {
    const t = window.__manorTerminals?.get(id)?.term;
    if (!t) throw new Error(`no terminal for ${id}`);
    const b = t.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < b.length; y++) out.push(b.getLine(y)?.translateToString(true) ?? "");
    return out.join("\n");
  }, paneId);
}

async function heldSize(window: Page, paneId: string) {
  return window.evaluate((id) => window.__manorTerminals?.get(id)?.heldSize() ?? null, paneId);
}

/** A workspace with tab A (returned) hidden behind a second tab. */
async function hiddenPane(
  app: Parameters<typeof bootWorkspaceWithTerminal>[0],
  window: Page,
  tempHome: string,
): Promise<string> {
  await bootWorkspaceWithTerminal(app, window, tempHome, "hold");
  const paneId = await activePaneId(window);
  await awaitShellReady(window, tempHome, paneId);
  await openTerminalTab(window);
  await expect.poll(() => heldSize(window, paneId)).not.toBeNull();
  return paneId;
}

async function showFirstTab(window: Page): Promise<void> {
  await window.locator('[data-testid="tab"]').first().click();
}

test("a hidden pane holds a little output and shows all of it, in order, on show", async ({
  app,
  window,
  tempHome,
}) => {
  const paneId = await hiddenPane(app, window, tempHome);
  await ptyType(window, paneId, "seq 1 300; echo zq-$((40+2))-end\r");
  await expect.poll(() => scrollback(tempHome, paneId), { timeout: 15_000 }).toContain("zq-42-end");
  await window.waitForTimeout(300);

  expect(await written(window, paneId)).not.toContain("zq-42-end");
  expect((await heldSize(window, paneId))?.chars).toBeGreaterThan(1000);

  await showFirstTab(window);
  await expect.poll(() => heldSize(window, paneId)).toBeNull();
  const text = await written(window, paneId);
  const numbers = text.split("\n").map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).map(Number);
  expect(numbers).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
  expect(text.match(/^zq-42-end$/gm)).toHaveLength(1);
  await shot(window, "small-replay-shown");
});

test("a hidden pane past the hold limit restores from the snapshot, with no seam", async ({
  app,
  window,
  tempHome,
}) => {
  const paneId = await hiddenPane(app, window, tempHome);
  await ptyType(window, paneId, "yes zqhold | head -c 3000000; echo; echo zq-$((40+3))-end\r");
  await expect.poll(() => scrollback(tempHome, paneId), { timeout: 30_000 }).toContain("zq-43-end");
  await expect.poll(() => heldSize(window, paneId)).toEqual({ chars: expect.any(Number), overflowed: true });
  expect(await written(window, paneId)).not.toContain("zqhold");

  await showFirstTab(window);
  await expect.poll(() => written(window, paneId), { timeout: 10_000 }).toMatch(/^zq-43-end$/m);
  expect((await written(window, paneId)).match(/^zq-43-end$/gm)).toHaveLength(1);

  // It keeps streaming and takes typing.
  await window.locator('[data-testid="terminal-pane"]:visible').first().click();
  await window.keyboard.type("echo zq-$((40+4))-typed");
  await window.keyboard.press("Enter");
  await expect.poll(() => written(window, paneId)).toMatch(/^zq-44-typed$/m);
  await shot(window, "overflow-restored-shown");
});

test("a hidden pane answers a terminal query on time", async ({ app, window, tempHome }) => {
  const paneId = await hiddenPane(app, window, tempHome);
  // Cursor position, then background colour: each `read` waits 2s for its reply.
  await ptyType(
    window,
    paneId,
    "printf '\\e[6n'; read -rs -t 2 -d R r && echo zq-dsr-ok || echo zq-dsr-none; " +
      "printf '\\e]11;?\\a'; read -rs -t 2 -d '\\' r && echo zq-osc-ok || echo zq-osc-none\r",
  );
  await expect.poll(() => scrollback(tempHome, paneId), { timeout: 10_000 }).toMatch(/zq-osc-(ok|none)/);
  const out = scrollback(tempHome, paneId);
  expect(out).toContain("zq-dsr-ok");
  expect(out).toContain("zq-osc-ok");
  // Still holding: the catch-up answered the query without unhiding anything.
  expect(await heldSize(window, paneId)).not.toBeNull();
});

test("a hidden pane's title change reaches its tab while hidden", async ({ app, window, tempHome }) => {
  const paneId = await hiddenPane(app, window, tempHome);
  await ptyType(window, paneId, "printf '\\e]2;zq-held-title\\a'; seq 1 50\r");
  await expect(window.locator('[data-testid="tab-title"]').first()).toHaveText("zq-held-title", {
    timeout: 10_000,
  });
  expect((await heldSize(window, paneId))?.chars).toBeGreaterThan(0);
  await shot(window, "title-while-hidden");
});

test("a pane in a hidden window holds its output and catches up when shown", async ({
  app,
  window,
  tempHome,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "hold");
  const paneId = await activePaneId(window);
  await awaitShellReady(window, tempHome, paneId);

  const setVisibility = (state: "hidden" | "visible") =>
    window.evaluate((s) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
      document.dispatchEvent(new Event("visibilitychange"));
    }, state);

  await setVisibility("hidden");
  await expect.poll(() => heldSize(window, paneId)).not.toBeNull();
  await ptyType(window, paneId, "echo zq-$((40+5))-behind\r");
  await expect.poll(() => scrollback(tempHome, paneId)).toContain("zq-45-behind");
  await window.waitForTimeout(300);
  expect(await written(window, paneId)).not.toMatch(/^zq-45-behind$/m);

  await setVisibility("visible");
  await expect.poll(() => written(window, paneId)).toMatch(/^zq-45-behind$/m);
  expect(await heldSize(window, paneId)).toBeNull();
});
