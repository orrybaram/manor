import type { ElectronApplication, Page } from "@playwright/test";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";
import { clickMenuItem } from "./helpers/window";

/**
 * The whole app works from the keyboard (ADR-175).
 *
 * Every interaction after boot is a key press: no `click()`. Booting may click
 * the import button — that is setup, not the thing under test. The suite was
 * written before the fixes, so it is red until the ADR's tickets land.
 *
 * Selector contract the implementation honours:
 * - `[data-focus-region="sidebar|tabbar|pane|statusbar"]` on region roots
 * - `project-header`, `home-row`, `workspace-item` (`aria-current="true"` when
 *   active) test ids in the sidebar
 * - `role="tablist"` / `role="tab"` + `aria-selected`, `tab`, `tab-close`,
 *   and `aria-label="New tab"` on the "+" button
 * - `settings-nav-<section>` on every settings nav button
 * - `[role="menu"]` for an open Radix context menu
 */

/** Focus polls are short: a red run should finish in minutes, not hours. */
const FOCUS = { timeout: 3_000 };

// ── Helpers ──────────────────────────────────────────────────────────────

/** Name of the focus region that holds `document.activeElement`, if any. */
const focusRegion = (window: Page) =>
  window.evaluate(() => {
    const region = document.activeElement?.closest<HTMLElement>(
      "[data-focus-region]",
    );
    return region?.dataset.focusRegion ?? null;
  });

/** True while xterm's hidden input holds focus — i.e. typing reaches the PTY. */
const terminalFocused = (window: Page) =>
  window.evaluate(
    () => !!document.activeElement?.classList.contains("xterm-helper-textarea"),
  );

/**
 * True when the focused element draws a visible focus indicator: a non-zero
 * outline or a box-shadow.
 */
const hasVisibleFocus = (window: Page) =>
  window.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return false;
    const cs = getComputedStyle(el);
    const outline =
      cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
    const shadow = cs.boxShadow !== "none" && cs.boxShadow !== "";
    return outline || shadow;
  });

/** Short description of the focused element, for failure messages. */
const describeActive = (window: Page) =>
  window.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return "body";
    const tid = el.getAttribute("data-testid");
    const label =
      el.getAttribute("aria-label") ??
      el.getAttribute("title") ??
      (el.textContent ?? "").trim().slice(0, 30);
    return `${el.tagName.toLowerCase()}${tid ? `[${tid}]` : ""} "${label}"`;
  });

/** `data-testid` of the focused element. */
const focusedTestId = (window: Page) =>
  window.evaluate(
    () => document.activeElement?.getAttribute("data-testid") ?? null,
  );

/** The `data-workspace-path` of the workspace row that holds focus, if any. */
const focusedRowPath = (window: Page) =>
  window.evaluate(() => {
    const el = document.activeElement;
    if (!el?.matches('[data-testid="workspace-item"]')) return null;
    return el.getAttribute("data-workspace-path");
  });

/** `aria-current` of the focused workspace row. */
const focusedRowIsCurrent = (window: Page) =>
  window.evaluate(
    () =>
      document.activeElement?.matches(
        '[data-testid="workspace-item"][aria-current="true"]',
      ) ?? false,
  );

/** `data-tab-id` of the focused tab, if a tab holds focus. */
const focusedTabId = (window: Page) =>
  window.evaluate(() => {
    const el = document.activeElement;
    if (!el?.matches('[data-testid="tab"]')) return null;
    return el.getAttribute("data-tab-id");
  });

/** True when focus sits on the tab that is currently selected. */
const selectedTabFocused = (window: Page) =>
  window.evaluate(
    () =>
      document.activeElement?.matches(
        '[data-testid="tab"][role="tab"][aria-selected="true"]',
      ) ?? false,
  );

/** True when focus is on (or inside) any sidebar row. */
const rowFocused = (window: Page) =>
  window.evaluate(
    () => !!document.activeElement?.closest("[data-sidebar-row]"),
  );

const visibleTabs = (window: Page) =>
  window.locator('[data-testid="tab"]:visible');
const workspaceRows = (window: Page) =>
  window.locator('[data-testid="workspace-item"]');
const workspaceRow = (window: Page, path: string) =>
  window.locator(
    `[data-testid="workspace-item"][data-workspace-path="${path}"]`,
  );
const openMenu = (window: Page) => window.locator('[role="menu"]:visible');
const paletteInput = (window: Page) => window.locator("[cmdk-input]");

/**
 * Pointer-only controls: visible elements with `cursor: pointer` that can't
 * take focus and aren't inside something that can. Children of a pointer
 * parent that is itself reported are skipped, so one bad control is one line.
 *
 * A `tabindex="-1"` element counts only as a member of a roving-tabindex
 * composite (sidebar rows, tabs): one member holds the Tab stop and the arrow
 * keys reach the rest. Anywhere else, -1 means the keyboard cannot get there.
 * A `<label>` is a pointer target for its control, so it passes when that
 * control can take focus.
 */
const pointerOnly = (window: Page, scope = "body") =>
  window.evaluate((scope) => {
    const root = document.querySelector(scope);
    if (!root) return [`scope ${scope} not found`];
    const ROVING = "[data-sidebar-row],[role='tab']";
    const focusable = (el: Element) =>
      (el as HTMLElement).tabIndex >= 0 ||
      el.matches(ROVING) ||
      el.matches("button,a[href],input,select,textarea,[contenteditable]");
    const out: string[] = [];
    for (const el of Array.from(root.querySelectorAll("*"))) {
      const h = el as HTMLElement;
      if (getComputedStyle(h).cursor !== "pointer") continue;
      if (!h.offsetParent && getComputedStyle(h).position !== "fixed") continue;
      if (
        focusable(h) ||
        h.closest(`button,a[href],[tabindex]:not([tabindex='-1']),${ROVING}`)
      )
        continue;
      if (h instanceof HTMLLabelElement) {
        const control =
          h.control ?? h.querySelector("button,input,select,textarea");
        if (control && focusable(control)) continue;
      }
      if (
        h.parentElement &&
        getComputedStyle(h.parentElement).cursor === "pointer" &&
        !focusable(h.parentElement)
      )
        continue;
      out.push(
        `${h.tagName.toLowerCase()}.${h.className.toString().slice(0, 50)} tid=${h
          .closest("[data-testid]")
          ?.getAttribute("data-testid")} "${(h.textContent ?? "")
          .trim()
          .slice(0, 30)}"`,
      );
    }
    return out;
  }, scope);

/**
 * Boot a project with one extra workspace and a terminal in it, and wait for
 * the terminal to hold the keyboard. Returns the paths of the project's main
 * row and the new workspace's row (which is the active one).
 */
async function boot(
  app: ElectronApplication,
  window: Page,
  tempHome: string,
  name: string,
): Promise<{ mainPath: string; wsPath: string }> {
  await bootWorkspaceWithTerminal(app, window, tempHome, name);
  const rows = workspaceRows(window);
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  const wsPath = await rows
    .filter({ hasText: name })
    .getAttribute("data-workspace-path");
  const mainPath = await rows.first().getAttribute("data-workspace-path");
  expect(wsPath).toBeTruthy();
  expect(mainPath).toBeTruthy();
  expect(mainPath).not.toBe(wsPath);
  await expect.poll(() => terminalFocused(window), { timeout: 10_000 }).toBe(
    true,
  );
  return { mainPath: mainPath!, wsPath: wsPath! };
}

/** Press `key` until `done()` holds, at most `max` times. */
async function pressUntil(
  window: Page,
  key: string,
  done: () => Promise<boolean>,
  max: number,
): Promise<boolean> {
  for (let i = 0; i < max; i++) {
    await window.keyboard.press(key);
    await window.waitForTimeout(80);
    if (await done()) return true;
  }
  return false;
}

// ── Regions ──────────────────────────────────────────────────────────────

test.describe("regions", () => {
  /**
   * F6 cycles sidebar → tab bar → pane (→ status bar when it has focusables)
   * and Shift+F6 walks back. The terminal no longer keeps the keyboard.
   */
  test("F6 / Shift+F6 cycle the regions", async ({ app, window, tempHome }) => {
    await boot(app, window, tempHome, "ws-regions");

    const statusHasFocusables = await window.evaluate(() => {
      const root = document.querySelector('[data-focus-region="statusbar"]');
      if (!root) return false;
      return !!root.querySelector(
        "button:not([disabled]),a[href],input,[tabindex]:not([tabindex='-1'])",
      );
    });

    // From the pane, forward: status bar (if any) then sidebar.
    await window.keyboard.press("F6");
    if (statusHasFocusables) {
      await expect.poll(() => focusRegion(window), FOCUS).toBe("statusbar");
      await window.keyboard.press("F6");
    }
    await expect.poll(() => focusRegion(window), FOCUS).toBe("sidebar");
    await window.keyboard.press("F6");
    await expect.poll(() => focusRegion(window), FOCUS).toBe("tabbar");
    await window.keyboard.press("F6");
    await expect.poll(() => terminalFocused(window), FOCUS).toBe(true);

    // Backward.
    await window.keyboard.press("Shift+F6");
    await expect.poll(() => focusRegion(window), FOCUS).toBe("tabbar");
    await window.keyboard.press("Shift+F6");
    await expect.poll(() => focusRegion(window), FOCUS).toBe("sidebar");

    // A full forward cycle from the pane returns to it within 5 presses, and
    // visits exactly the regions that can take focus.
    await window.keyboard.press("Escape");
    await expect.poll(() => terminalFocused(window), FOCUS).toBe(true);
    const visited: (string | null)[] = [];
    for (let i = 0; i < 5; i++) {
      await window.keyboard.press("F6");
      await window.waitForTimeout(100);
      if (await terminalFocused(window)) break;
      visited.push(await focusRegion(window));
    }
    expect(await terminalFocused(window)).toBe(true);
    expect(visited).toEqual(
      statusHasFocusables
        ? ["statusbar", "sidebar", "tabbar"]
        : ["sidebar", "tabbar"],
    );
  });

  /**
   * ⌘⇧E focuses the active workspace row, ⌘⇧Y the selected tab. ⌘⇧E opens a
   * hidden sidebar first.
   */
  test("⌘⇧E and ⌘⇧Y jump straight to a region", async ({
    app,
    window,
    tempHome,
  }) => {
    const { wsPath } = await boot(app, window, tempHome, "ws-direct");

    await window.keyboard.press("Meta+Shift+e");
    await expect.poll(() => focusedRowPath(window), FOCUS).toBe(wsPath);
    await expect.poll(() => focusedRowIsCurrent(window), FOCUS).toBe(true);

    await window.keyboard.press("Meta+Shift+y");
    await expect.poll(() => selectedTabFocused(window), FOCUS).toBe(true);

    // Sidebar hidden: ⌘⇧E brings it back and focuses the row.
    await window.keyboard.press("Meta+\\");
    await expect(window.getByTestId("home-row")).toHaveCount(0, FOCUS);
    await window.keyboard.press("Meta+Shift+e");
    await expect(window.getByTestId("home-row")).toBeVisible(FOCUS);
    await expect.poll(() => focusedRowPath(window), FOCUS).toBe(wsPath);

    // Sidebar hidden: ⌘⇧Y still reaches the tab bar.
    await window.keyboard.press("Meta+\\");
    await expect(window.getByTestId("home-row")).toHaveCount(0, FOCUS);
    await window.keyboard.press("Meta+Shift+y");
    await expect.poll(() => selectedTabFocused(window), FOCUS).toBe(true);
  });
});

// ── Sidebar ──────────────────────────────────────────────────────────────

test.describe("sidebar", () => {
  /**
   * ↑ walks from the active row through the project header to Home;
   * Home / End jump; the sidebar is a single Tab stop.
   */
  test("arrows, Home/End and a single Tab stop", async ({
    app,
    window,
    tempHome,
  }) => {
    const { mainPath, wsPath } = await boot(app, window, tempHome, "ws-nav");

    await window.keyboard.press("Meta+Shift+e");
    await expect.poll(() => focusedRowPath(window), FOCUS).toBe(wsPath);

    await window.keyboard.press("ArrowUp");
    await expect.poll(() => focusedRowPath(window), FOCUS).toBe(mainPath);
    await window.keyboard.press("ArrowUp");
    await expect.poll(() => focusedTestId(window), FOCUS).toBe(
      "project-header",
    );
    await window.keyboard.press("ArrowUp");
    await expect.poll(() => focusedTestId(window), FOCUS).toBe("home-row");

    // End: the last row in the sidebar.
    await window.keyboard.press("End");
    await expect
      .poll(
        () =>
          window.evaluate(() => {
            const rows = document.querySelectorAll("[data-sidebar-row]");
            return document.activeElement === rows[rows.length - 1];
          }),
        FOCUS,
      )
      .toBe(true);

    // Home: the first row, which is Home itself.
    await window.keyboard.press("Home");
    await expect.poll(() => focusedTestId(window), FOCUS).toBe("home-row");

    // Tab from a row leaves the rows altogether rather than visiting each.
    await window.keyboard.press("ArrowDown");
    await expect.poll(() => focusedTestId(window), FOCUS).toBe(
      "project-header",
    );
    await window.keyboard.press("ArrowDown");
    await expect.poll(() => focusedRowPath(window), FOCUS).toBe(mainPath);
    await window.keyboard.press("Tab");
    await expect.poll(() => rowFocused(window), FOCUS).toBe(false);
  });

  /**
   * Enter opens a workspace (it used to rename it). F2 renames; Escape
   * cancels and leaves focus on the row. App shortcuts still work while the
   * rename input is open.
   */
  test("Enter opens a workspace, F2 renames it", async ({
    app,
    window,
    tempHome,
  }) => {
    const { mainPath, wsPath } = await boot(app, window, tempHome, "ws-open");
    const mainRow = workspaceRow(window, mainPath);
    const wsRow = workspaceRow(window, wsPath);

    await window.keyboard.press("Meta+Shift+e");
    await expect.poll(() => focusedRowPath(window), FOCUS).toBe(wsPath);

    // Enter on the non-active row opens it; no rename.
    await window.keyboard.press("ArrowUp");
    await expect.poll(() => focusedRowPath(window), FOCUS).toBe(mainPath);
    await window.keyboard.press("Enter");
    await expect(mainRow).toHaveAttribute("aria-current", "true", FOCUS);
    await expect(window.getByTestId("workspace-name-input")).toHaveCount(0);

    // F2 renames; Escape cancels and focus stays on the row.
    await window.keyboard.press("ArrowDown");
    await expect.poll(() => focusedRowPath(window), FOCUS).toBe(wsPath);
    await window.keyboard.press("F2");
    await expect(wsRow.getByTestId("workspace-name-input")).toBeVisible(FOCUS);
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("workspace-name-input")).toHaveCount(0, FOCUS);
    await expect.poll(() => focusedRowPath(window), FOCUS).toBe(wsPath);

    // ⌘T is not swallowed by an open rename input.
    const before = await visibleTabs(window).count();
    await window.keyboard.press("F2");
    await expect(wsRow.getByTestId("workspace-name-input")).toBeVisible(FOCUS);
    await window.keyboard.press("Meta+t");
    await expect(visibleTabs(window)).toHaveCount(before + 1, FOCUS);
  });

  /** ← / → collapse and expand a project; Enter toggles it. */
  test("project headers collapse from the keyboard", async ({
    app,
    window,
    tempHome,
  }) => {
    const { mainPath } = await boot(app, window, tempHome, "ws-collapse");
    const rows = workspaceRows(window);

    await window.keyboard.press("Meta+Shift+e");
    await window.keyboard.press("ArrowUp");
    await expect.poll(() => focusedRowPath(window), FOCUS).toBe(mainPath);
    await window.keyboard.press("ArrowUp");
    await expect.poll(() => focusedTestId(window), FOCUS).toBe(
      "project-header",
    );

    await window.keyboard.press("ArrowLeft");
    await expect(rows).toHaveCount(0, FOCUS);
    await window.keyboard.press("ArrowRight");
    await expect(rows).toHaveCount(2, FOCUS);

    await window.keyboard.press("Enter");
    await expect(rows).toHaveCount(0, FOCUS);
    await expect.poll(() => focusedTestId(window), FOCUS).toBe(
      "project-header",
    );
    await window.keyboard.press("Enter");
    await expect(rows).toHaveCount(2, FOCUS);
  });

  /** Enter on the Home row shows the home view. */
  test("Enter on Home opens the home view", async ({
    app,
    window,
    tempHome,
  }) => {
    await boot(app, window, tempHome, "ws-home");

    await window.keyboard.press("Meta+Shift+e");
    await window.keyboard.press("Home");
    await expect.poll(() => focusedTestId(window), FOCUS).toBe("home-row");
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("home-view")).toBeVisible(FOCUS);
  });
});

// ── Context menus ────────────────────────────────────────────────────────

test.describe("context menus", () => {
  /**
   * Shift+F10 opens a row's context menu, arrows move through it, and Escape
   * closes it with focus back on the row. ⌘. does the same on a tab.
   */
  test("Shift+F10 and ⌘. open context menus", async ({
    app,
    window,
    tempHome,
  }) => {
    const { wsPath } = await boot(app, window, tempHome, "ws-menu");

    await window.keyboard.press("Meta+Shift+e");
    await expect.poll(() => focusedRowPath(window), FOCUS).toBe(wsPath);

    await window.keyboard.press("Shift+F10");
    await expect(openMenu(window)).toHaveCount(1, FOCUS);
    await window.keyboard.press("ArrowDown");
    await expect(
      openMenu(window).locator("[role='menuitem'][data-highlighted]"),
    ).toHaveCount(1, FOCUS);
    await window.keyboard.press("Escape");
    await expect(openMenu(window)).toHaveCount(0, FOCUS);
    await expect.poll(() => focusedRowPath(window), FOCUS).toBe(wsPath);

    // Same on a tab, via ⌘.
    await window.keyboard.press("Meta+Shift+y");
    await expect.poll(() => selectedTabFocused(window), FOCUS).toBe(true);
    const tabId = await focusedTabId(window);
    await window.keyboard.press("Meta+Period");
    await expect(openMenu(window)).toHaveCount(1, FOCUS);
    await window.keyboard.press("ArrowDown");
    await expect(
      openMenu(window).locator("[role='menuitem'][data-highlighted]"),
    ).toHaveCount(1, FOCUS);
    await window.keyboard.press("Escape");
    await expect(openMenu(window)).toHaveCount(0, FOCUS);
    await expect.poll(() => focusedTabId(window), FOCUS).toBe(tabId);
  });
});

// ── Tab bar ──────────────────────────────────────────────────────────────

test.describe("tab bar", () => {
  /**
   * Arrows move focus between tabs without selecting; Enter selects. Tab
   * reaches the focused tab's close button, and Enter closes it.
   */
  test("roving focus, select and close", async ({ app, window, tempHome }) => {
    await boot(app, window, tempHome, "ws-tabs");
    const tabs = visibleTabs(window);
    await expect(tabs).toHaveCount(1);

    await window.keyboard.press("Meta+t");
    await expect(tabs).toHaveCount(2, { timeout: 10_000 });
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    const firstId = await tabs.nth(0).getAttribute("data-tab-id");
    const secondId = await tabs.nth(1).getAttribute("data-tab-id");

    await expect(window.getByRole("tablist")).toHaveCount(1);
    await expect(window.getByRole("button", { name: "New tab" })).toBeVisible();

    await window.keyboard.press("Meta+Shift+y");
    await expect.poll(() => focusedTabId(window), FOCUS).toBe(secondId);

    // ← moves focus only.
    await window.keyboard.press("ArrowLeft");
    await expect.poll(() => focusedTabId(window), FOCUS).toBe(firstId);
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "false");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");

    // Enter selects.
    await window.keyboard.press("Enter");
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true", FOCUS);

    // Tab reaches the close button; Enter closes that tab.
    await window.keyboard.press("Tab");
    await expect.poll(() => focusedTestId(window), FOCUS).toBe("tab-close");
    await window.keyboard.press("Enter");
    await expect(tabs).toHaveCount(1, FOCUS);
  });
});

// ── Dialogs ──────────────────────────────────────────────────────────────

test.describe("dialogs", () => {
  /**
   * Settings is navigable by Tab/Enter, holds app shortcuts off while open,
   * and hands focus back to the terminal on Escape.
   */
  test("settings from the keyboard", async ({ app, window, tempHome }) => {
    await boot(app, window, tempHome, "ws-settings");
    const modal = window.getByTestId("settings-modal");
    const sections = () =>
      modal
        .locator("[data-settings-section]")
        .evaluateAll((els) =>
          els.map((e) => e.getAttribute("data-settings-section")),
        );

    await window.keyboard.press("Meta+,");
    await expect(modal).toBeVisible(FOCUS);
    const before = await sections();

    const reached = await pressUntil(
      window,
      "Tab",
      async () => (await focusedTestId(window)) === "settings-nav-appearance",
      10,
    );
    expect(reached, `focus ended on ${await describeActive(window)}`).toBe(
      true,
    );
    await window.keyboard.press("Enter");
    await expect.poll(sections, FOCUS).toContain("app-font");
    expect(await sections()).not.toEqual(before);

    // ⌘T with Settings open does not touch the workspace behind it.
    const tabCount = await visibleTabs(window).count();
    await window.keyboard.press("Meta+t");
    await window.waitForTimeout(500);
    await expect(visibleTabs(window)).toHaveCount(tabCount);
    await expect(modal).toBeVisible();

    await window.keyboard.press("Escape");
    await expect(modal).toBeHidden(FOCUS);
    await expect.poll(() => terminalFocused(window), FOCUS).toBe(true);
  });

  /** A dialog gives focus back to where it was opened from, not the pane. */
  test("the palette restores focus to a sidebar row", async ({
    app,
    window,
    tempHome,
  }) => {
    const { wsPath } = await boot(app, window, tempHome, "ws-restore");

    await window.keyboard.press("Meta+Shift+e");
    await expect.poll(() => focusedRowPath(window), FOCUS).toBe(wsPath);

    await window.keyboard.press("Meta+k");
    await expect(paletteInput(window)).toBeFocused(FOCUS);
    await window.keyboard.press("Escape");
    await expect(paletteInput(window)).toHaveCount(0, FOCUS);
    await expect.poll(() => focusedRowPath(window), FOCUS).toBe(wsPath);
  });

  /** The palette reaches Settings sections and the agents view. */
  test("the palette reaches settings and agents", async ({
    app,
    window,
    tempHome,
  }) => {
    await boot(app, window, tempHome, "ws-palette");

    await window.keyboard.press("Meta+k");
    await expect(paletteInput(window)).toBeFocused(FOCUS);
    await window.keyboard.type("Settings: Appearance");
    await window.keyboard.press("Enter");
    const modal = window.getByTestId("settings-modal");
    await expect(modal).toBeVisible(FOCUS);
    await expect(
      modal.locator('[data-settings-section="app-font"]'),
    ).toBeVisible(FOCUS);
    await window.keyboard.press("Escape");
    await expect(modal).toBeHidden(FOCUS);

    await window.keyboard.press("Meta+k");
    await expect(paletteInput(window)).toBeFocused(FOCUS);
    await window.keyboard.type("View All Agents");
    await window.keyboard.press("Enter");
    const agents = window.getByTestId("agents-modal");
    await expect(agents).toBeVisible(FOCUS);
    await window.keyboard.press("Escape");
    await expect(agents).toBeHidden(FOCUS);
  });

  /**
   * The notifications bell is reachable from the sidebar, Enter opens the
   * popover, and Escape closes it with focus back on the bell.
   */
  test("notifications from the keyboard", async ({
    app,
    window,
    tempHome,
  }) => {
    await boot(app, window, tempHome, "ws-bell");

    await window.keyboard.press("Meta+Shift+e");
    await expect.poll(() => focusRegion(window), FOCUS).toBe("sidebar");
    // The bell sits in the sidebar's title bar, before the rows.
    const reached = await pressUntil(
      window,
      "Shift+Tab",
      async () => (await focusedTestId(window)) === "notifications-bell",
      6,
    );
    expect(reached, `focus ended on ${await describeActive(window)}`).toBe(
      true,
    );

    await window.keyboard.press("Enter");
    const popover = window.getByTestId("notifications-popover");
    await expect(popover).toBeVisible(FOCUS);
    await window.keyboard.press("Escape");
    await expect(popover).toBeHidden(FOCUS);
    await expect.poll(() => focusedTestId(window), FOCUS).toBe(
      "notifications-bell",
    );
  });

  /** A workspace can be created without touching the mouse. */
  test("new workspace, keyboard only", async ({ app, window, tempHome }) => {
    await boot(app, window, tempHome, "ws-first");

    await window.keyboard.press("Meta+Shift+n");
    const dialog = window.getByTestId("new-workspace-dialog");
    await expect(dialog).toBeVisible(FOCUS);
    await expect(window.getByTestId("new-workspace-name-input")).toBeFocused(
      FOCUS,
    );
    await window.keyboard.type("ws-kbd");
    await window.keyboard.press("Enter");
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(
      workspaceRows(window).filter({ hasText: "ws-kbd" }),
    ).toHaveCount(1, { timeout: 30_000 });
  });
});

// ── Browser pane ─────────────────────────────────────────────────────────

test.describe("browser pane", () => {
  /** App shortcuts and F6 still work while a web page has focus. */
  test("shortcuts reach the app from a focused page", async ({
    app,
    window,
    tempHome,
  }) => {
    await boot(app, window, tempHome, "ws-browser");

    await window.keyboard.press("Meta+Shift+b");
    const webview = window.locator("webview:visible");
    await expect(webview).toHaveCount(1, { timeout: 10_000 });

    // Load a page through the URL bar.
    await window.keyboard.press("Meta+l");
    await expect
      .poll(() => window.evaluate(() => document.activeElement?.tagName), FOCUS)
      .toBe("INPUT");
    await window.keyboard.type("about:blank");
    await window.keyboard.press("Enter");

    const activeTag = () =>
      window.evaluate(() => document.activeElement?.tagName ?? null);

    /**
     * Focus the guest page and press a key *inside it*. Playwright's keyboard
     * drives the host renderer over CDP and never reaches a <webview> guest,
     * so the key is injected into the guest's own WebContents instead — the
     * same path a real key press takes, `before-input-event` included.
     */
    const pressInPage = async (keyCode: string, meta = false) => {
      await window.evaluate(() =>
        (document.querySelector("webview:not([hidden])") as HTMLElement | null)
          ?.focus(),
      );
      await expect.poll(activeTag, FOCUS).toBe("WEBVIEW");
      await app.evaluate(
        ({ webContents }, { keyCode, meta }) => {
          const guest = webContents
            .getAllWebContents()
            .find((wc) => wc.getType() === "webview");
          if (!guest) throw new Error("no webview guest");
          guest.focus();
          const modifiers: "meta"[] = meta ? ["meta"] : [];
          guest.sendInputEvent({ type: "keyDown", keyCode, modifiers });
          guest.sendInputEvent({ type: "keyUp", keyCode, modifiers });
        },
        { keyCode, meta },
      );
    };

    // Sanity: a browser key the page already forwards gets through, so a
    // failure below is the app's, not the harness's.
    await pressInPage("l", true);
    await expect.poll(activeTag, FOCUS).toBe("INPUT");

    // ⌘K from the page opens the palette.
    await pressInPage("k", true);
    await expect.soft(paletteInput(window)).toBeVisible(FOCUS);
    if (await paletteInput(window).isVisible()) {
      await window.keyboard.press("Escape");
      await expect(paletteInput(window)).toHaveCount(0, FOCUS);
    }

    // F6 from the page moves on to the next region.
    await pressInPage("F6");
    await expect
      .poll(() => focusRegion(window), FOCUS)
      .toMatch(/^(statusbar|sidebar)$/);
  });
});

// ── Popout windows ───────────────────────────────────────────────────────

test.describe("popout window", () => {
  /**
   * A popout has no palette, settings or sidebar of its own: ⌘K and ⌘,
   * pressed there open them in the main window.
   */
  test("⌘K and ⌘, in a popout reach the main window", async ({
    app,
    window,
    tempHome,
  }) => {
    await boot(app, window, tempHome, "ws-popout");

    // Keep a tab in the main window, then move the selected one out.
    await window.keyboard.press("Meta+t");
    await expect(visibleTabs(window)).toHaveCount(2, { timeout: 10_000 });
    const popoutOpened = app.waitForEvent("window");
    await expect
      .poll(() =>
        clickMenuItem(app, ["Window", "Move Tab to New Window"]).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    const popout = await popoutOpened;
    await popout.waitForLoadState("domcontentloaded");
    await expect(popout.locator('[data-testid="tab"]:visible')).toHaveCount(1, {
      timeout: 15_000,
    });
    await expect(visibleTabs(window)).toHaveCount(1, FOCUS);
    // The popout's own terminal takes the keyboard once it is up.
    await expect
      .poll(() => terminalFocused(popout), { timeout: 10_000 })
      .toBe(true);

    await popout.keyboard.press("Meta+k");
    await expect(paletteInput(window)).toBeVisible(FOCUS);
    await expect(paletteInput(popout)).toHaveCount(0);
    await window.keyboard.press("Escape");
    await expect(paletteInput(window)).toHaveCount(0, FOCUS);

    await popout.keyboard.press("Meta+,");
    await expect(window.getByTestId("settings-modal")).toBeVisible(FOCUS);
    await expect(popout.getByTestId("settings-modal")).toHaveCount(0);
  });
});

// ── Visibility and coverage ──────────────────────────────────────────────

test.describe("focus visibility", () => {
  /** Every keyboard stop draws a focus indicator. */
  test("focus is visible at every stop", async ({ app, window, tempHome }) => {
    await boot(app, window, tempHome, "ws-visible");
    const invisible: string[] = [];
    const check = async (where: string) => {
      if (!(await hasVisibleFocus(window))) {
        invisible.push(`${where}: ${await describeActive(window)}`);
      }
    };

    // Region stops (the terminal draws its own cursor; skip it). The walk has
    // to actually leave the pane, or there is nothing to check.
    const regions = new Set<string>();
    for (let i = 0; i < 4; i++) {
      await window.keyboard.press("F6");
      await window.waitForTimeout(100);
      if (await terminalFocused(window)) continue;
      const region = await focusRegion(window);
      if (region) regions.add(region);
      await check(`F6 #${i + 1} (${region})`);
    }
    expect
      .soft([...regions], "regions F6 reached")
      .toEqual(expect.arrayContaining(["sidebar", "tabbar"]));

    // Every sidebar row.
    await window.keyboard.press("Meta+Shift+e");
    await window.keyboard.press("Home");
    await window.waitForTimeout(100);
    const rowCount = await window.locator("[data-sidebar-row]").count();
    expect(rowCount).toBeGreaterThan(0);
    for (let i = 0; i < rowCount; i++) {
      if (i > 0) {
        await window.keyboard.press("ArrowDown");
        await window.waitForTimeout(60);
      }
      if (!(await rowFocused(window))) {
        invisible.push(`row #${i}: focus is not on a row`);
        continue;
      }
      await check(`row #${i}`);
    }

    expect(invisible).toEqual([]);
  });

  /**
   * No visible control is pointer-only: anything with `cursor: pointer` can
   * take focus or sits inside something that can.
   */
  test("no pointer-only controls", async ({ app, window, tempHome }) => {
    await boot(app, window, tempHome, "ws-sweep");

    expect.soft(await pointerOnly(window), "main window").toEqual([]);

    await window.keyboard.press("Meta+,");
    const modal = window.getByTestId("settings-modal");
    await expect(modal).toBeVisible(FOCUS);
    expect
      .soft(
        await pointerOnly(window, '[data-testid="settings-modal"]'),
        "settings",
      )
      .toEqual([]);
    await window.keyboard.press("Escape");
    await expect(modal).toBeHidden(FOCUS);

    // Reachability of the bell is covered above; this only needs the popover
    // open, so focus the bell directly rather than depend on that test.
    await window.getByTestId("notifications-bell").focus();
    await window.keyboard.press("Enter");
    const popover = window.getByTestId("notifications-popover");
    await expect(popover).toBeVisible(FOCUS);
    expect
      .soft(
        await pointerOnly(window, '[data-testid="notifications-popover"]'),
        "notifications popover",
      )
      .toEqual([]);
  });
});
