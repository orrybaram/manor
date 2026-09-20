import fs from "fs";
import path from "path";
import {
  bootWorkspaceWithTerminal,
  expect,
  killApp,
  launchApp,
  test,
} from "./fixtures";

/**
 * The selection is this renderer's and survives a relaunch (ADR-179 D3).
 *
 * Layout is the Manor server's — the tab set comes back because the server
 * persisted it. *Which* tab is selected is not: it lives in this window's own
 * `~/.manor/viewport.json`, and the point of this test is that the two roads
 * meet, so a desktop that was on the second tab reopens on the second tab
 * rather than on tab one.
 *
 * Launches its own app instances rather than taking the fixture's: the fixture
 * owns the shutdown of the app it created, and killing that one mid-test
 * leaves its teardown holding a disposed handle.
 */
test("the selected tab survives a relaunch", async ({ tempHome }) => {
  let secondTabId: string;

  const first = await launchApp(tempHome);
  try {
    const window = await first.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await bootWorkspaceWithTerminal(first, window, tempHome, "viewport-restart");

    // A second tab, which `new-tab` selects — that is the command's hint,
    // applied because this window is the one that sent it.
    await window.keyboard.press("Meta+t");
    const tabs = window.locator('[data-testid="tab"]');
    await expect.poll(() => tabs.count(), { timeout: 30_000 }).toBe(2);

    secondTabId = (await tabs.nth(1).getAttribute("data-tab-id"))!;
    expect(secondTabId).toBeTruthy();
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");

    // The viewport file is written 300ms after the last selection change.
    await expect
      .poll(
        () => {
          const file = path.join(tempHome, ".manor", "viewport.json");
          if (!fs.existsSync(file)) return "";
          return fs.readFileSync(file, "utf-8");
        },
        { timeout: 15_000 },
      )
      .toContain(secondTabId);
  } finally {
    await killApp(first);
  }

  const relaunched = await launchApp(tempHome);
  try {
    const window = await relaunched.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    const tabs = window.locator('[data-testid="tab"]');
    await expect.poll(() => tabs.count(), { timeout: 30_000 }).toBe(2);
    await expect(tabs.nth(1)).toHaveAttribute("data-tab-id", secondTabId!);
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true", {
      timeout: 15_000,
    });
  } finally {
    await killApp(relaunched);
  }
});
