import type { Page } from "@playwright/test";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";

/**
 * The sidebar is allowed to hold the keyboard (ADR-172). Clicking a row used
 * to lose focus instantly: switching workspaces flips the terminal's
 * "am I the focused pane" selector, and its effect called focus() straight
 * back. Escape is the way back into the pane.
 */

/** The `data-workspace-path` of the row focus currently sits on, if any. */
const focusedRow = (window: Page) =>
  window.evaluate(() => {
    const row = document.activeElement?.closest("[data-sidebar-row]");
    return row?.getAttribute("data-workspace-path") ?? null;
  });

/** True while xterm's hidden input holds focus — i.e. typing reaches the PTY. */
const terminalFocused = (window: Page) =>
  window.evaluate(() =>
    !!document.activeElement?.classList.contains("xterm-helper-textarea"),
  );

test("a clicked row keeps focus, arrows move it, Escape gives it back", async ({
  app,
  window,
  tempHome,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-focus");

  const rows = window.locator('[data-testid="workspace-item"]');
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  // The workspace whose terminal is open sits below the project's main one,
  // so ↑ from it lands on a row and Escape returns to a live pane.
  const wsRow = rows.filter({ hasText: "ws-focus" });
  const wsPath = await wsRow.getAttribute("data-workspace-path");
  const mainPath = await rows.first().getAttribute("data-workspace-path");
  expect(mainPath).not.toBe(wsPath);

  // The click switches workspaces; the terminal must not snatch focus back.
  await wsRow.click();
  await expect.poll(() => focusedRow(window), { timeout: 5_000 }).toBe(wsPath);

  // ↑ / ↓ walk the rows.
  await window.keyboard.press("ArrowUp");
  await expect.poll(() => focusedRow(window)).toBe(mainPath);
  await window.keyboard.press("ArrowDown");
  await expect.poll(() => focusedRow(window)).toBe(wsPath);

  // Escape hands the keyboard back to the pane.
  await window.keyboard.press("Escape");
  await expect
    .poll(() => terminalFocused(window), { timeout: 5_000 })
    .toBe(true);
});
