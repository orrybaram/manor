import fs from "fs";
import path from "path";
import { expect, type ElectronApplication, type Page } from "@playwright/test";

import {
  assertVisiblePaneCount,
  bootWorkspaceWithTerminal,
  createWorkspace,
  importSeededProject,
  openTerminalTab,
  test,
} from "./fixtures";
import { Filmstrip } from "./helpers/filmstrip";
import { readSessionMeta } from "./helpers/local-api";
import { openWebApp } from "./helpers/phone";
import { closeSettings, enableRemoteControl, pairDevice } from "./helpers/settings";
import { activePaneId, awaitShellReady } from "./helpers/terminal";

/**
 * ADR-181 end to end: the phone layout is the desk's own tree, walked one
 * leaf at a time (D1), reached through a top bar, a drawer and a bottom
 * sheet (D3) instead of the desk's sidebar and split dividers, with the
 * command palette standing in for every drag idiom phone mode turns off
 * (D5) and a tap wired straight into xterm's own textarea for the native
 * keyboard (D6).
 *
 * Same discipline as `web-app.spec.ts`: nothing here reaches inside the app
 * to fabricate state. A phone is an ordinary Playwright page that knows an
 * address and a bearer token, driven at a 390×844 viewport — the only thing
 * that tells this renderer to be a phone at all (ADR-181 D2).
 */

const WORKSPACE_1 = "phone-primary";
const WORKSPACE_2 = "phone-second";

/** One line of `RemoteAuditLog` (`electron/remote-control/audit.ts`). */
interface AuditEntry {
  route: string;
  transport?: "http" | "bridge";
  target: string | null;
  outcome: "sent" | "rejected" | "failed";
}

/** Where main writes the remote-control audit trail — mirrors `remoteAuditFile()` in `electron/paths.ts`. */
function auditFile(tempHome: string): string {
  const dataDir =
    process.platform === "darwin"
      ? path.join(tempHome, "Library", "Application Support", "Manor")
      : path.join(tempHome, ".local", "share", "Manor");
  return path.join(dataDir, "remote-audit.jsonl");
}

/** Every audit line written so far. Malformed or missing is read as none. */
function auditEntries(tempHome: string): AuditEntry[] {
  const file = auditFile(tempHome);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditEntry);
}

/** How many `pty.create` calls a bridge viewer has made so far. */
function bridgeCreateCount(tempHome: string): number {
  return auditEntries(tempHome).filter(
    (e) => e.transport === "bridge" && e.route === "pty.create",
  ).length;
}

/**
 * The grid a pane is drawn at, read off the terminal itself rather than the
 * DOM — mirrors `web-app.spec.ts`'s `paneGrid`. A pane that remounted would
 * either be missing here (a fresh `Terminal` not yet registered) or report a
 * grid the fit that follows a mount produces; a pane that only changed
 * visibility reports exactly what it already had.
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

/** Every tab button, in DOM order. */
function tabs(page: Page) {
  return page.locator('[data-testid="tab"]');
}

/** The pane ids a page currently renders (visible or not — every pane of the active panel's tabs stays mounted, ADR-181 D1). */
async function allPaneIdsOnPage(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="workspace-pane"]')
    .evaluateAll((panes) =>
      panes.map((pane) => pane.getAttribute("data-pane-id") ?? ""),
    );
}

/** What `document.activeElement` is, read out for the touch-focus assertions. */
interface ActiveElementInfo {
  className: string;
  paneId: string | null;
  autocapitalize: string | null;
  autocorrect: string | null;
  autocomplete: string | null;
  spellcheck: string | null;
}

function activeElementInfo(page: Page): Promise<ActiveElementInfo | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    return {
      className: el.className,
      paneId: el.closest("[data-pane-id]")?.getAttribute("data-pane-id") ?? null,
      autocapitalize: el.getAttribute("autocapitalize"),
      autocorrect: el.getAttribute("autocorrect"),
      autocomplete: el.getAttribute("autocomplete"),
      spellcheck: el.getAttribute("spellcheck"),
    };
  });
}

/**
 * Run the command labelled `label` in an already-open palette — the phone
 * variant of `web-app.spec.ts`'s `runPaletteCommand`, minus the ⌘K a phone
 * keyboard has no chord for. The caller opens the palette itself (the top
 * bar's button) since a phone test typically wants to assert on the open
 * palette — full screen, ADR-181 D5 — before anything is typed into it.
 */
async function runOpenPaletteCommand(page: Page, label: string): Promise<void> {
  const input = page.getByPlaceholder("Type a command...");
  await expect(input).toBeVisible();
  await input.fill(label);
  const item = page.locator("[cmdk-item]", { hasText: label }).first();
  await expect(item).toBeVisible();
  await item.click();
  await expect(input).not.toBeVisible();
}

/** Right-click a tab and pop it into a window of its own — mirrors `detach.spec.ts`. */
async function detachTab(window: Page, index: number): Promise<void> {
  await tabs(window).nth(index).click({ button: "right" });
  await window.getByRole("menuitem", { name: "Move to New Window" }).click();
}

/**
 * Resize a `BrowserWindow`'s content area — the CSS viewport `useLayoutMode`
 * reads. `which` picks it out by creation order rather than a fixed index,
 * so "the popup" still means the popup once a second window exists.
 */
function setWindowContentSize(
  app: ElectronApplication,
  which: "first" | "last",
  width: number,
  height: number,
): Promise<void> {
  return app.evaluate(
    ({ BrowserWindow }, opts) => {
      const wins = BrowserWindow.getAllWindows();
      const win = opts.which === "first" ? wins[0] : wins[wins.length - 1];
      win.setContentSize(opts.width, opts.height);
    },
    { which, width, height },
  );
}

test.describe("phone layout (ADR-181)", () => {
  test.setTimeout(240_000);

  /**
   * Scenarios 1, 2, 3, 4 and 7 share one paired device and one browser page
   * — the ticket's own suggestion for keeping the spec fast — but each
   * block below stands on its own assertions.
   */
  test("a phone walks the desk's layout: one pane at a time, the switcher moves nothing but focus, the drawer, the palette, and a tap focuses xterm", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const film = new Filmstrip("phone");

    // ── Desk setup ───────────────────────────────────────────────────────
    // Workspace 1: tab1 splits into paneA/paneB, tab2 holds paneC alone.
    await importSeededProject(app, window, tempHome);
    await createWorkspace(window, WORKSPACE_1);
    await openTerminalTab(window);
    const paneA = await activePaneId(window);
    await awaitShellReady(window, tempHome, paneA);
    const tab1Id = await tabs(window).first().getAttribute("data-tab-id");
    expect(tab1Id).toBeTruthy();

    await window.keyboard.press("Meta+d");
    await assertVisiblePaneCount(window, 2);
    const paneB = (await allPaneIdsOnPage(window)).find((id) => id !== paneA);
    expect(paneB).toBeTruthy();
    await awaitShellReady(window, tempHome, paneB!);

    await window.keyboard.press("Meta+t");
    await expect.poll(() => tabs(window).count(), { timeout: 15_000 }).toBe(2);
    await assertVisiblePaneCount(window, 1);
    const paneC = await activePaneId(window);
    await awaitShellReady(window, tempHome, paneC);

    // Workspace 2: one tab, one pane (paneW2).
    await createWorkspace(window, WORKSPACE_2);
    await openTerminalTab(window);
    const paneW2 = await activePaneId(window);
    await awaitShellReady(window, tempHome, paneW2);

    // Back to workspace 1, tab 1 — the split — so a fresh browser boots
    // there (a browser with empty localStorage mirrors the desk's own
    // viewport, same as `web-app.spec.ts`'s first test establishes).
    await window.getByTestId("workspace-item").filter({ hasText: WORKSPACE_1 }).click();
    await window.locator(`[data-tab-id="${tab1Id}"]`).click();
    await assertVisiblePaneCount(window, 2);
    await film.shot(window, "desk-ready");

    // ── Pair at full, open the phone ────────────────────────────────────
    const port = await enableRemoteControl(window);
    const device = await pairDevice(window, { label: "phone", capability: "full" });
    await closeSettings(window);

    const client = await openWebApp(port, device.token, {
      viewport: { width: 390, height: 844 },
      context: { isMobile: true, hasTouch: true },
    });

    try {
      // 1. One pane at a time. The top bar, the tab strip — no status bar,
      // no sidebar inline — and exactly one pane visible: the one the
      // viewport focuses (ADR-179 D3), which the pane switcher's own
      // "current" row proves rather than assuming.
      await expect(client.page.getByTestId("phone-top-bar")).toBeVisible({
        timeout: 30_000,
      });
      await expect(tabs(client.page)).toHaveCount(2);
      await expect(
        client.page.locator('[data-focus-region="statusbar"]'),
      ).toHaveCount(0);
      await expect(
        client.page.locator('[data-focus-region="sidebar"]'),
      ).toHaveCount(0);
      await assertVisiblePaneCount(client.page, 1);
      const initialPaneId = await activePaneId(client.page);
      expect([paneA, paneB]).toContain(initialPaneId);
      await film.shot(client.page, "01-one-pane");

      await client.page.getByTestId("phone-pane-switcher-button").click();
      const sheet = client.page.getByTestId("pane-switcher");
      await expect(sheet).toBeVisible();
      await expect(
        client.page.locator('[data-testid="pane-switcher-row"][aria-current="true"]'),
      ).toHaveAttribute("data-pane-id", initialPaneId);
      await film.shot(client.page, "02-pane-switcher-open");

      // 2. The switcher moves, and nothing remounts. Every pane of the tab
      // is already mounted (ADR-181 D1), so picking the split's other pane
      // must not create a new pty or resize either pane's grid.
      const otherPaneId = (initialPaneId === paneA ? paneB : paneA)!;
      const auditBefore = bridgeCreateCount(tempHome);
      const gridABefore = await paneGrid(client.page, paneA);
      const gridBBefore = await paneGrid(client.page, paneB!);
      const metaABefore = await readSessionMeta(request, tempHome, paneA);
      const metaBBefore = await readSessionMeta(request, tempHome, paneB!);

      await client.page
        .locator(`[data-testid="pane-switcher-row"][data-pane-id="${otherPaneId}"]`)
        .click();
      await expect(sheet).not.toBeVisible();
      await assertVisiblePaneCount(client.page, 1);
      await expect
        .poll(() => activePaneId(client.page), { timeout: 10_000 })
        .toBe(otherPaneId);

      expect(bridgeCreateCount(tempHome)).toBe(auditBefore);
      expect(await paneGrid(client.page, paneA)).toEqual(gridABefore);
      expect(await paneGrid(client.page, paneB!)).toEqual(gridBBefore);
      expect((await readSessionMeta(request, tempHome, paneA)).cols).toBe(
        metaABefore.cols,
      );
      expect((await readSessionMeta(request, tempHome, paneA)).rows).toBe(
        metaABefore.rows,
      );
      expect((await readSessionMeta(request, tempHome, paneB!)).cols).toBe(
        metaBBefore.cols,
      );
      expect((await readSessionMeta(request, tempHome, paneB!)).rows).toBe(
        metaBBefore.rows,
      );
      await film.shot(client.page, "03-switched-pane");

      // 3. The drawer. Opening it and picking the other workspace closes
      // it and shows that workspace.
      await client.page.getByTestId("phone-drawer-toggle").click();
      const drawer = client.page.getByTestId("sidebar-drawer");
      await expect(drawer).toBeVisible();
      await film.shot(client.page, "04-drawer-open");

      await client.page
        .getByTestId("workspace-item")
        .filter({ hasText: WORKSPACE_2 })
        .click();
      await expect(drawer).not.toBeVisible();
      await expect
        .poll(() => activePaneId(client.page), { timeout: 15_000 })
        .toBe(paneW2);
      await expect(client.page.getByTestId("phone-top-bar")).toContainText(
        WORKSPACE_2,
      );
      await film.shot(client.page, "05-drawer-switched-workspace");

      // 4. The palette opens full screen from the top-bar button, and a
      // pane action run from it lands on the desk's layout too. The desk
      // follows the browser onto workspace 2 first, so the split it is
      // about to run is one the desk itself can be seen picking up.
      await window.getByTestId("workspace-item").filter({ hasText: WORKSPACE_2 }).click();
      await assertVisiblePaneCount(window, 1);

      await client.page.getByTestId("phone-palette-button").click();
      const palette = client.page.getByTestId("command-palette");
      await expect(palette).toBeVisible();
      const paletteBox = await palette.boundingBox();
      // Full screen: within a few pixels of the 390×844 viewport, not the
      // desk's centered card.
      expect(paletteBox?.width).toBeGreaterThan(380);
      expect(paletteBox?.height).toBeGreaterThan(800);
      await film.shot(client.page, "06-palette-full-screen");

      await runOpenPaletteCommand(client.page, "Split Horizontal");

      await assertVisiblePaneCount(window, 2);
      await film.shot(window, "07-desk-after-phone-split");

      // 7. A tap is a keyboard-ready focus. Whichever half of the fresh
      // split the phone is showing now, tapping it focuses xterm's own
      // textarea synchronously — not a click, a `touchend`-driven focus
      // (`useTerminalTouch.ts`), so the soft keyboard has something to have
      // raised for.
      const tappedPaneId = await activePaneId(client.page);
      await awaitShellReady(window, tempHome, tappedPaneId);

      const pane = client.page.locator('[data-testid="terminal-pane"]:visible').first();
      await pane.tap();
      const info = await activeElementInfo(client.page);
      expect(info?.className).toContain("xterm-helper-textarea");
      expect(info?.paneId).toBe(tappedPaneId);
      expect(info?.autocapitalize).toBe("off");
      expect(info?.autocorrect).toBe("off");
      expect(info?.autocomplete).toBe("off");
      expect(info?.spellcheck).toBe("false");

      const viewportMeta = await client.page
        .locator('meta[name="viewport"]')
        .getAttribute("content");
      expect(viewportMeta).toContain("interactive-widget=resizes-visual");
      await film.shot(client.page, "08-tap-focus");

      // Tapping twice in a row still leaves focus in the same place — the
      // blur-then-focus path `useTerminalTouch.ts` takes for iOS, so a
      // *second* tap (same element already focused) still raises rather
      // than leaving the keyboard down.
      await pane.tap();
      await pane.tap();
      const info2 = await activeElementInfo(client.page);
      expect(info2?.className).toContain("xterm-helper-textarea");
      expect(info2?.paneId).toBe(tappedPaneId);
    } finally {
      film.write("browser-console.log", client.log.join("\n") + "\n");
      await client.close();
    }
  });

  /**
   * ADR-181 D2: the breakpoint is width, in every renderer but a detached
   * window. Dragging the desktop window narrow is the desk's own free
   * responsive pass; a detached window (ADR-179 D4) is excluded on purpose —
   * it is already a single claimed tab with no chrome, often narrow by
   * design.
   */
  test("width, not platform: the desktop window becomes phone chrome narrow, a detached window does not", async ({
    app,
    window,
    tempHome,
  }) => {
    await bootWorkspaceWithTerminal(app, window, tempHome, "phone-width");

    await expect(window.getByTestId("phone-top-bar")).toHaveCount(0);
    await expect(window.locator("[data-layout]")).toHaveAttribute(
      "data-layout",
      "desk",
    );

    await setWindowContentSize(app, "first", 600, 700);
    await expect(window.getByTestId("phone-top-bar")).toBeVisible({
      timeout: 10_000,
    });
    await expect(window.locator("[data-layout]")).toHaveAttribute(
      "data-layout",
      "phone",
    );

    await setWindowContentSize(app, "first", 1280, 800);
    await expect(window.getByTestId("phone-top-bar")).toHaveCount(0);
    await expect(window.locator("[data-layout]")).toHaveAttribute(
      "data-layout",
      "desk",
    );

    // A second tab, so detaching one leaves the primary something to show.
    await window.keyboard.press("Meta+t");
    await expect.poll(() => tabs(window).count(), { timeout: 15_000 }).toBe(2);

    const popup = await Promise.all([
      app.waitForEvent("window"),
      detachTab(window, 1),
    ]).then(([win]) => win);
    await popup.waitForLoadState("domcontentloaded");

    await setWindowContentSize(app, "last", 500, 700);
    // No breakpoint to poll for here — the assertion is that nothing ever
    // changes, so give the (absent) transition a moment it would need if it
    // were going to happen, then check it did not.
    await popup.waitForTimeout(1_000);
    await expect(popup.getByTestId("phone-top-bar")).toHaveCount(0);
    await expect(popup.locator("[data-layout]")).toHaveAttribute(
      "data-layout",
      "desk",
    );
  });

  /**
   * ADR-181 D5: dragging a tab is one gesture — reorder, move-into-panel,
   * detach-by-drag — gated off entirely in phone mode rather than left
   * half-working under a thumb. `draggable={false}` on the tab element is
   * the actual mechanism (`TabBar.tsx`), so a real drag attempt is a no-op:
   * the tab order never moves.
   */
  test("no drags on a phone: a tab does not start a drag", async ({
    app,
    window,
    tempHome,
  }) => {
    await bootWorkspaceWithTerminal(app, window, tempHome, "phone-nodrag");
    await window.keyboard.press("Meta+t");
    await expect.poll(() => tabs(window).count(), { timeout: 15_000 }).toBe(2);

    const port = await enableRemoteControl(window);
    const device = await pairDevice(window, {
      label: "no-drag phone",
      capability: "full",
    });
    await closeSettings(window);

    const client = await openWebApp(port, device.token, {
      viewport: { width: 390, height: 844 },
      context: { isMobile: true, hasTouch: true },
    });
    try {
      await expect(tabs(client.page)).toHaveCount(2);
      const draggable = await tabs(client.page).first().getAttribute("draggable");
      expect(draggable).toBe("false");

      const idsBefore = await tabs(client.page).evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-tab-id")),
      );
      await tabs(client.page)
        .nth(0)
        .dragTo(tabs(client.page).nth(1))
        .catch(() => {
          // A non-draggable element refusing the gesture outright is also a
          // pass — the property under test is "the tab order never moves".
        });
      const idsAfter = await tabs(client.page).evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-tab-id")),
      );
      expect(idsAfter).toEqual(idsBefore);
    } finally {
      await client.close();
    }
  });
});
