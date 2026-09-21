import fs from "fs";
import path from "path";
import { expect, type Page } from "@playwright/test";

import {
  assertVisiblePaneCount,
  bootWorkspaceWithTerminal,
  createWorkspace,
  importSeededProject,
  openTerminalTab,
  test,
} from "./fixtures";
import { FAKE_AGENT, FAKE_AGENT_BANNER, FAKE_AGENT_ECHO } from "./helpers/fake-agent";
import { Filmstrip } from "./helpers/filmstrip";
import { layout, readSessionMeta, waitForVisibleSession } from "./helpers/local-api";
import { openWebApp } from "./helpers/phone";
import {
  closeSettings,
  enableRemoteControl,
  openRemoteControlSettings,
  pairDevice,
} from "./helpers/settings";
import {
  activePaneId,
  awaitShellReady,
  runInTerminal,
  scrollback,
} from "./helpers/terminal";
import { closeRendererWindows } from "./helpers/window";

/**
 * ADR-178 slice 1 end to end: a browser on a PC opens `/app`, pairs at `full`,
 * shows the sidebar and a live terminal for an existing session, and can type
 * into it — the tracer bullet D10 names, proven through the real listener,
 * the real web bundle (`dist-electron/web/`) and the real daemon.
 *
 * Same discipline as `remote-control.spec.ts`: nothing here reaches inside the
 * app to fabricate state. The session comes from the fake agent reporting its
 * own lifecycle, the token comes from the pairing dialog, and the browser is
 * an ordinary Playwright page that knows nothing but an address and a bearer
 * token — the whole contract a `full` device gets.
 *
 * The web app is the desktop renderer, so it shares the desktop's test ids
 * and its "terminal draws into a WebGL canvas" problem (see the README).
 * `paneText` below reads a pane's grid the same way
 * `claude-resize-duplication.spec.ts` does: through `window.__manorTerminals`,
 * the serializer every live terminal registers itself under for exactly this.
 */

/** Passed to the fake agent, which puts it in the window title → the agent name. */
const AGENT_TITLE = "e2e-web-agent";
/** The project `tempHome` is seeded with, as the sidebar labels it. */
const PROJECT_NAME = "test-project";

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

/**
 * A pane's whole grid, read off the terminal itself rather than the DOM.
 *
 * xterm draws into a WebGL canvas (README: "Selector strategy"), so there is
 * nothing to read with a locator — on the desktop or in this browser, which
 * runs the identical component. `window.__manorTerminals` is the seam the app
 * already exposes for exactly this: a live `Terminal` and the `SerializeAddon`
 * already loaded onto it, keyed by pane id.
 */
async function paneText(page: Page, paneId: string): Promise<string> {
  return page.evaluate((id) => {
    const handle = window.__manorTerminals?.get(id);
    if (!handle) throw new Error(`no terminal registered for ${id}`);
    return handle.serialize.serialize({ scrollback: 20_000 });
  }, paneId);
}

/** The font size xterm is actually rendering a pane's glyphs at. */
async function paneFontSize(page: Page, paneId: string): Promise<number | null> {
  return page.evaluate((id) => {
    const handle = window.__manorTerminals?.get(id);
    return handle?.term.options.fontSize ?? null;
  }, paneId);
}

/** The grid a pane is drawn at, read off the terminal rather than the DOM. */
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

/** A `pty.winsizeOwner` frame, as the page received it (`WinsizeOwnerEvent`). */
interface OwnerEvent {
  paneId: string;
  cols: number;
  rows: number;
  owner: boolean;
}

/** Where `recordWinsizeOwner` parks the frames it has seen. */
interface OwnerEventBag {
  __winsizeOwnerEvents?: OwnerEvent[];
}

/**
 * Start recording the `pty.winsizeOwner` frames this page receives for a pane.
 *
 * Subscribed through `window.electronAPI` — the same call `TerminalPane` makes
 * — because the frame *is* the assertion here: a viewer that becomes the owner
 * without making a call of its own can only have learned it this way
 * (ADR-179 D6, ADR-180 D6). Watching the follower badge instead would also
 * pass for a pane that simply went away.
 */
async function recordWinsizeOwner(page: Page, paneId: string): Promise<void> {
  await page.evaluate((id) => {
    const bag = window as unknown as OwnerEventBag;
    bag.__winsizeOwnerEvents = [];
    window.electronAPI.pty.onWinsizeOwner(id, (payload) => {
      bag.__winsizeOwnerEvents?.push(payload);
    });
  }, paneId);
}

/** Every frame `recordWinsizeOwner` has collected so far. */
function winsizeOwnerEvents(page: Page): Promise<OwnerEvent[]> {
  return page.evaluate(
    () => (window as unknown as OwnerEventBag).__winsizeOwnerEvents ?? [],
  );
}

/**
 * Call `ns.method` in a page and report how it settled, rejection included.
 *
 * `page.evaluate` cannot carry an `Error` back across the boundary, and the
 * fields that matter are the ones a plain message would lose: `code` is what
 * tells `unavailable:web` from a handler that failed, and `name` is what a
 * component switches on (`BridgeUnavailableError`).
 */
async function invokeInPage(
  page: Page,
  ns: string,
  method: string,
  args: (string | number | boolean | null)[],
): Promise<{
  ok: boolean;
  name: string | null;
  code: string | null;
  message: string | null;
}> {
  return page.evaluate(async (call) => {
    const api = window.electronAPI as unknown as Record<
      string,
      Record<string, (...a: unknown[]) => Promise<unknown>>
    >;
    try {
      await api[call.ns][call.method](...call.args);
      return { ok: true, name: null, code: null, message: null };
    } catch (err) {
      const e = err as { name?: string; code?: string; message?: string };
      return {
        ok: false,
        name: e.name ?? null,
        code: e.code ?? null,
        message: e.message ?? null,
      };
    }
  }, { ns, method, args });
}

/**
 * The paired devices, as a page's own `remoteControl.getStatus()` reports
 * them.
 *
 * `getStatus` is deliberately *not* `LOCAL_ONLY` (ADR-180 ticket 10) — a
 * device's settings page should not be lying to it about the surface it is on
 * — so the same call works from the desk and from a `full` browser, and each
 * is a witness for the other.
 */
function devicesSeenBy(page: Page): Promise<{ id: string; label: string }[]> {
  return page.evaluate(async () => {
    const status = await window.electronAPI.remoteControl.getStatus();
    return status.devices.map((d) => ({ id: d.id, label: d.label }));
  });
}

/** Every tab button, in DOM order. */
function tabs(page: Page) {
  return page.locator('[data-testid="tab"]');
}

/** The one tab button this renderer currently has selected. */
function selectedTab(page: Page) {
  return page.locator('[data-testid="tab"][aria-selected="true"]');
}

/** The pane ids the active tab is showing, in DOM order — mirrors `smoke.spec.ts`. */
async function visiblePaneIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="workspace-pane"]:visible')
    .evaluateAll((panes) =>
      panes.map((pane) => pane.getAttribute("data-pane-id") ?? ""),
    );
}

/**
 * Open the command palette and run the command labelled `label`.
 *
 * The same route `command-palette-frequent.spec.ts` drives: this is the
 * affordance ADR-179 D7 claims a browser has for structural commands
 * (split, close, …) that have no dedicated keybinding pressed here.
 */
async function runPaletteCommand(page: Page, label: string): Promise<void> {
  const input = page.getByPlaceholder("Type a command...");
  await page.keyboard.press("Meta+k");
  await expect(input).toBeVisible();
  await input.fill(label);
  const item = page.locator("[cmdk-item]", { hasText: label }).first();
  await expect(item).toBeVisible();
  await item.click();
  await expect(input).not.toBeVisible();
}

test.describe("web app (ADR-178 slice 1)", () => {
  test.setTimeout(240_000);

  test("a PC browser pairs at full, sees the sidebar, and drives a live terminal without moving the winsize or leaving a keystroke trail", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const film = new Filmstrip("web-app");

    // Boot a real session on the desktop first — the web app has to find it
    // already running, not start it.
    await importSeededProject(app, window, tempHome);
    await createWorkspace(window, "web-e2e");
    await openTerminalTab(window);

    const desktopPaneId = await activePaneId(window);
    await awaitShellReady(window, tempHome, desktopPaneId);
    await runInTerminal(window, `"${FAKE_AGENT}" ${AGENT_TITLE}`);
    const session = await waitForVisibleSession(request, tempHome, {
      name: AGENT_TITLE,
    });
    await film.shot(window, "desktop-agent-running");

    const desktopFontSize = await paneFontSize(window, desktopPaneId);
    expect(desktopFontSize).not.toBeNull();
    const { cols: colsBeforeBrowser } = await readSessionMeta(
      request,
      tempHome,
      session.id,
    );

    const port = await enableRemoteControl(window);
    const device = await pairDevice(window, {
      label: "pc browser",
      capability: "full",
    });
    await film.shot(window, "settings-web-device-paired");
    await closeSettings(window);

    const client = await openWebApp(port, device.token);
    try {
      // 1. Pairs at full and boots: the sidebar shows the seeded project and
      // the workspace `createWorkspace` made.
      await expect(
        client.page.getByTestId("project-header").filter({ hasText: PROJECT_NAME }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        client.page.getByTestId("workspace-item").filter({ hasText: "web-e2e" }),
      ).toBeVisible({ timeout: 10_000 });
      await film.shot(client.page, "browser-sidebar");

      // 2. A live terminal, driven from the browser. Layout is read-shared
      // (D6 is slice 2, but reads already are), so the browser boots onto the
      // exact pane the desktop has open — not a pane of its own.
      const browserPaneId = await activePaneId(client.page);
      expect(browserPaneId).toBe(desktopPaneId);

      await expect
        .poll(() => paneText(client.page, browserPaneId), { timeout: 20_000 })
        .toContain(FAKE_AGENT_BANNER);
      await film.shot(client.page, "browser-terminal-banner");

      const message = "hello from the browser";
      await runInTerminal(client.page, message);
      await expect
        .poll(() => paneText(client.page, browserPaneId), { timeout: 20_000 })
        .toContain(`${FAKE_AGENT_ECHO} ${message}`);
      // The same byte stream, so the desktop's own view has it too — proof
      // this went through the pty, not just the browser's local echo.
      await expect
        .poll(() => paneText(window, desktopPaneId), { timeout: 20_000 })
        .toContain(`${FAKE_AGENT_ECHO} ${message}`);
      await film.shot(client.page, "browser-terminal-echo");
      await film.shot(window, "desktop-after-browser-send");

      // 3. The desktop owns the winsize: narrowing the browser's viewport
      // shrinks the font, not the grid, and the desktop's `cols` never moves.
      await client.page.setViewportSize({ width: 700, height: 800 });
      // useTerminalResize's settle window is 400ms; give it margin.
      await client.page.waitForTimeout(1_000);

      const { cols: colsAfterBrowser } = await readSessionMeta(
        request,
        tempHome,
        session.id,
      );
      expect(colsAfterBrowser).toBe(colsBeforeBrowser);

      await expect(client.page.getByTestId("terminal-follower")).toBeVisible();
      const followerFontSize = await paneFontSize(client.page, browserPaneId);
      expect(followerFontSize).not.toBeNull();
      expect(followerFontSize!).toBeGreaterThanOrEqual(6);
      expect(followerFontSize!).toBeLessThanOrEqual(desktopFontSize!);
      await film.shot(client.page, "browser-follower-narrow");
    } finally {
      film.write("browser-console.log", client.log.join("\n") + "\n");
      await client.close();
    }

    // 5. Audit: no line for keystrokes. Attaching a pane from the browser is
    // two audited bridge calls — `pty.create`, then the `agents.setPaneContext`
    // that follows every successful create (ticket 10) — both aimed at the
    // pane the two viewers shared.
    //
    // `agents.markSeen` may join them, and is the reason this list is not
    // two entries long any more (ADR-180 ticket 13). A browser that can see
    // an agent marks it seen like any other viewer — `markVisibleAgentsSeen`
    // fires on every viewport change — and ADR-180 ticket 9 put that call on
    // the handler table and in `MUTATING`. Whether it appears depends on
    // whether the desktop got there first: the unseen sets live on the Manor
    // server, so a flag the desk already cleared leaves the browser nothing
    // to clear. Both outcomes are correct, which is why this asserts the
    // route is *allowed* rather than that it happened.
    //
    // It targets an **agent** id, not a pane id: `bridgeTarget` records the
    // first string argument, which for `markSeen(agentId)` is the agent.
    const entries = auditEntries(tempHome);
    expect(entries.some((e) => e.route === "pty.write")).toBe(false);

    const paneScoped = ["pty.create", "agents.setPaneContext"];
    const bridgeEntries = entries.filter((e) => e.transport === "bridge");
    expect(bridgeEntries.map((e) => e.route)).toContain("pty.create");
    for (const entry of bridgeEntries) {
      expect([...paneScoped, "agents.markSeen"]).toContain(entry.route);
      if (paneScoped.includes(entry.route)) {
        expect(entry.target).toBe(desktopPaneId);
      }
      expect(entry.outcome).toBe("sent");
    }
  });

  /**
   * ADR-179 D6: with no desktop viewer left, the most recently attached
   * bridge viewer owns the pane's winsize, and it hears so live rather than
   * on its next `pty.create`.
   *
   * The desktop stops watching the pane by *closing* it (`Meta+w`) rather
   * than popping it into a window of its own and closing that: a popped tab
   * that is later unclaimed comes back to the primary's tab strip and
   * remounts there at once (every tab of a workspace stays mounted so
   * switching never sends a spurious `SIGWINCH` — see
   * `workspace-switching.spec.ts`), which would race this test against the
   * desktop reattaching. A closed pane does not come back on its own — only
   * an explicit reopen does — so the browser's ownership is stable, not just
   * transiently true. The trade is the note in the ticket: closing ends the
   * session after `REOPEN_GRACE_MS` unless it is reopened first, so this test
   * reads everything it needs well inside that ten-second grace, the same
   * margin `smoke.spec.ts`'s reopen test relies on.
   */
  test("a browser becomes the winsize owner once the desktop stops watching the pane", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const film = new Filmstrip("web-app-d6");

    await bootWorkspaceWithTerminal(app, window, tempHome, "d6-e2e");
    const desktopPaneId = await activePaneId(window);
    await awaitShellReady(window, tempHome, desktopPaneId);

    const port = await enableRemoteControl(window);
    const device = await pairDevice(window, {
      label: "d6 browser",
      capability: "full",
    });
    await closeSettings(window);

    const client = await openWebApp(port, device.token);
    try {
      const browserPaneId = await activePaneId(client.page);
      expect(browserPaneId).toBe(desktopPaneId);

      // The desktop owns the winsize while it has the pane mounted (D5): the
      // browser follows, and says so.
      await expect(
        client.page.getByTestId("terminal-follower"),
      ).toBeVisible({ timeout: 20_000 });
      await film.shot(client.page, "browser-follower-before");

      await window.keyboard.press("Meta+w");
      await expect(
        window.locator('[data-testid="terminal-pane"]'),
      ).toHaveCount(0, { timeout: 10_000 });

      // The browser is now the pane's only viewer: it hears so live, and its
      // next fit becomes the pane's real size — `readSessionMeta` reads that
      // size back from the daemon itself, not from anything the browser
      // claims about its own view.
      await expect(
        client.page.getByTestId("terminal-follower"),
      ).toHaveCount(0, { timeout: 5_000 });
      await film.shot(client.page, "browser-follower-after");

      const meta = await readSessionMeta(request, tempHome, desktopPaneId);
      expect(meta.cols).not.toBeNull();
      expect(meta.rows).not.toBeNull();
    } finally {
      film.write("browser-console-d6.log", client.log.join("\n") + "\n");
      await client.close();
    }
  });

  /**
   * The same hand-off with the pane still on screen: the desk goes away, the
   * browser keeps looking, and it is told — by a `pty.winsizeOwner` frame,
   * not by a call of its own — that the grid is its to drive now (ADR-179 D6,
   * reached from the desktop side since ADR-180 D6 made a window an ordinary
   * connection).
   *
   * Sits beside the test above rather than inside it because the two let go
   * differently, and only this one leaves the browser anything to inherit.
   * Closing the *pane* removes it from the layout for every renderer — the
   * browser's copy unmounts too — so the badge going away there is equally
   * true of a pane that simply vanished. Closing the *window* removes only a
   * viewer: the layout is the server's and the session is the daemon's, so
   * the pane stays in the browser, its owner's connection is released
   * (`releaseViewer`, `app-lifecycle.ts`), and ownership has somewhere to go.
   * It is also the sentence ADR-178 starts from — the desk is closed, and
   * the browser is still a terminal.
   *
   * Then the claim is cashed: the browser's viewport is widened, and the
   * daemon's grid follows it. Before the hand-off the same kind of change
   * moved nothing, which the first half pins.
   */
  test("the desk's window closes and the browser is told the winsize is its own", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const film = new Filmstrip("web-app-inherit");

    await bootWorkspaceWithTerminal(app, window, tempHome, "inherit-e2e");
    const paneId = await activePaneId(window);
    await awaitShellReady(window, tempHome, paneId);
    const deskCols = (await readSessionMeta(request, tempHome, paneId)).cols;
    expect(deskCols).not.toBeNull();

    const port = await enableRemoteControl(window);
    const device = await pairDevice(window, {
      label: "inherit browser",
      capability: "full",
    });
    await closeSettings(window);

    const client = await openWebApp(port, device.token);
    try {
      await expect(
        client.page
          .getByTestId("workspace-item")
          .filter({ hasText: "inherit-e2e" }),
      ).toBeVisible({ timeout: 30_000 });
      expect(await activePaneId(client.page)).toBe(paneId);
      await recordWinsizeOwner(client.page, paneId);

      // While the desk has the pane, the browser follows: narrowing it scales
      // its glyphs and leaves the session's grid exactly where the desk put it.
      const follower = client.page.getByTestId("terminal-follower");
      await expect(follower).toBeVisible({ timeout: 20_000 });
      await client.page.setViewportSize({ width: 700, height: 800 });
      await client.page.waitForTimeout(1_500);
      expect((await readSessionMeta(request, tempHome, paneId)).cols).toBe(
        deskCols,
      );
      await film.shot(client.page, "browser-follows-the-desk");

      await closeRendererWindows(app);

      // Told, not inferred.
      await expect
        .poll(() => winsizeOwnerEvents(client.page), { timeout: 20_000 })
        .toContainEqual(expect.objectContaining({ paneId, owner: true }));
      await expect(follower).toHaveCount(0, { timeout: 20_000 });
      // Still a terminal, still this pane: the desk leaving took nothing with
      // it.
      expect(await activePaneId(client.page)).toBe(paneId);
      await film.shot(client.page, "browser-owns-the-pane");

      // And the grid is the browser's to move now.
      await client.page.setViewportSize({ width: 1400, height: 900 });
      await expect
        .poll(
          async () => (await readSessionMeta(request, tempHome, paneId)).cols,
          { timeout: 20_000 },
        )
        .not.toBe(deskCols);
      // The daemon's grid and the browser's agree, and it is the browser's
      // measurement that got there: the grid moves from the stream (ADR-164),
      // so the two settle together a beat after the resize lands. Both
      // numbers are in the polled value so a failure shows the disagreement.
      await expect
        .poll(
          async () => {
            const [meta, grid] = await Promise.all([
              readSessionMeta(request, tempHome, paneId),
              paneGrid(client.page, paneId),
            ]);
            return {
              session: meta.cols,
              browser: grid.cols,
              agree: meta.cols === grid.cols,
            };
          },
          { timeout: 20_000 },
        )
        .toMatchObject({ agree: true });
      await film.shot(client.page, "browser-drives-the-grid");
    } finally {
      film.write("browser-console-inherit.log", client.log.join("\n") + "\n");
      await client.close();
    }
  });

  /**
   * ADR-179 D7 end to end: a browser's split, new tab, close and reopen are
   * ordinary layout commands, not a local-only fiction. Every assertion below
   * is made against the desktop window or the daemon's own scrollback file —
   * nothing is taken on the browser's word alone.
   *
   * Also pins D3's "tab set shared, selection local": a `layout.changed`
   * broadcast never moves a renderer off the tab it was looking at, so a
   * browser arranging its own tab does not drag the desk along with it.
   */
  test("the browser arranges the desk's layout, the desk follows, and back", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const film = new Filmstrip("web-app-d7");

    await bootWorkspaceWithTerminal(app, window, tempHome, "d7-e2e");
    const paneA = await activePaneId(window);
    await awaitShellReady(window, tempHome, paneA);
    const tab1Id = await tabs(window).first().getAttribute("data-tab-id");
    expect(tab1Id).toBeTruthy();

    const port = await enableRemoteControl(window);
    const device = await pairDevice(window, {
      label: "d7 browser",
      capability: "full",
    });
    await closeSettings(window);

    const client = await openWebApp(port, device.token);
    try {
      await expect(
        client.page.getByTestId("project-header").filter({ hasText: PROJECT_NAME }),
      ).toBeVisible({ timeout: 30_000 });
      const browserPaneId = await activePaneId(client.page);
      expect(browserPaneId).toBe(paneA);

      // 1. Browser splits, desk shows it.
      await runPaletteCommand(client.page, "Split Horizontal");
      await assertVisiblePaneCount(window, 2);
      await assertVisiblePaneCount(client.page, 2);
      const snapshotAfterSplit = await layout(request, tempHome);
      const tab1AfterSplit = snapshotAfterSplit.tabs.find(
        (t) => t.tabId === tab1Id,
      );
      expect(tab1AfterSplit?.panes).toHaveLength(2);
      const paneB = (await visiblePaneIds(window)).find((id) => id !== paneA);
      expect(paneB).toBeTruthy();
      await film.shot(window, "d7-desktop-after-browser-split");
      await film.shot(client.page, "d7-browser-after-split");

      // 3. The ADR-178 "layout changes aren't saved" refusal is gone — it
      // never toasts, on this split or anything after it.
      await expect(
        client.page.getByText("Layout changes aren't saved", { exact: false }),
      ).toHaveCount(0);

      // 2. Desk closes, browser follows, no error toast.
      await window
        .locator(`[data-pane-id="${paneB}"] [data-testid="terminal-pane"]`)
        .click();
      await window.keyboard.press("Meta+w");
      await assertVisiblePaneCount(window, 1);
      await assertVisiblePaneCount(client.page, 1);
      await expect(client.page.locator('[class*="iconError"]')).toHaveCount(0);
      await film.shot(client.page, "d7-browser-after-desktop-close");

      // 4. Selection is local: the tab set is shared, but which tab each
      // renderer is looking at is each renderer's own business (D3).
      await window.keyboard.press("Meta+t");
      await expect.poll(() => tabs(window).count(), { timeout: 15_000 }).toBe(2);
      const tab2Id = (
        await tabs(window).evaluateAll((els) =>
          els.map((el) => el.getAttribute("data-tab-id")),
        )
      ).find((id) => id !== tab1Id);
      expect(tab2Id).toBeTruthy();

      await client.page.locator(`[data-tab-id="${tab1Id}"]`).click();
      await window.locator(`[data-tab-id="${tab2Id}"]`).click();
      await expect(selectedTab(window)).toHaveAttribute("data-tab-id", tab2Id!);
      await expect(selectedTab(client.page)).toHaveAttribute(
        "data-tab-id",
        tab1Id!,
      );

      // One layout.changed, sent from the browser's own tab: it must not
      // drag the desk off tab2, and it does not move the browser either
      // (it was already on tab1).
      await runPaletteCommand(client.page, "Split Vertical");
      await expect
        .poll(
          async () =>
            (await layout(request, tempHome)).tabs.find(
              (t) => t.tabId === tab1Id,
            )?.panes.length,
          { timeout: 15_000 },
        )
        .toBe(2);
      await expect(selectedTab(window)).toHaveAttribute("data-tab-id", tab2Id!);
      await expect(selectedTab(client.page)).toHaveAttribute(
        "data-tab-id",
        tab1Id!,
      );
      await film.shot(window, "d7-desktop-keeps-its-own-tab");
      await film.shot(client.page, "d7-browser-keeps-its-own-tab");

      // 5. Reopen from the browser: close a pane on the desk, bring it back
      // with the browser's own keybinding — `reopen-pane` (Reopen Closed
      // Pane) is bound to Meta+Shift+t and has no command-palette entry
      // (`useCommands.tsx` never lists it), so the keybinding is the real
      // affordance a browser has for it — and the same shell reattaches,
      // same discipline as `smoke.spec.ts`'s reopen test.
      await window.locator(`[data-tab-id="${tab2Id}"]`).click();
      await assertVisiblePaneCount(window, 1);
      const paneD = await activePaneId(window);
      await awaitShellReady(window, tempHome, paneD);

      await window.keyboard.press("Meta+d");
      await assertVisiblePaneCount(window, 2);
      const paneG = (await visiblePaneIds(window)).find((id) => id !== paneD);
      expect(paneG).toBeTruthy();
      await awaitShellReady(window, tempHome, paneG!);

      await window
        .locator(`[data-pane-id="${paneG}"] [data-testid="terminal-pane"]`)
        .click();
      await window.keyboard.type("MARK=warm-reopen-from-browser");
      await window.keyboard.press("Enter");
      await expect
        .poll(() => scrollback(tempHome, paneG!), { timeout: 15_000 })
        .toContain("MARK=warm-reopen-from-browser");

      await window
        .locator(`[data-pane-id="${paneG}"] [data-testid="terminal-pane"]`)
        .click();
      await window.keyboard.press("Meta+w");
      await assertVisiblePaneCount(window, 1);

      // Well inside the 10s grace (REOPEN_GRACE_MS): the browser reopens it
      // and it is the same shell, not a fresh one.
      await client.page.keyboard.press("Meta+Shift+t");
      await expect
        .poll(
          async () =>
            (await layout(request, tempHome)).tabs.find(
              (t) => t.tabId === tab2Id,
            )?.panes.length,
          { timeout: 15_000 },
        )
        .toBe(2);
      await assertVisiblePaneCount(window, 2);

      await window
        .locator(`[data-pane-id="${paneG}"] [data-testid="terminal-pane"]`)
        .click();
      await window.keyboard.type('echo "mark:$MARK"');
      await window.keyboard.press("Enter");
      await expect
        .poll(() => scrollback(tempHome, paneG!), { timeout: 15_000 })
        .toContain("mark:warm-reopen-from-browser");
      await film.shot(window, "d7-desktop-after-browser-reopen");
      await film.shot(client.page, "d7-browser-after-reopen");
    } finally {
      film.write("browser-console-d7.log", client.log.join("\n") + "\n");
      await client.close();
    }
  });

  test("a send device cannot open the full web app", async ({ window }) => {
    const port = await enableRemoteControl(window);
    const device = await pairDevice(window, {
      label: "send-only phone",
      capability: "send",
    });
    await closeSettings(window);

    const client = await openWebApp(port, device.token);
    try {
      await expect(client.page.getByTestId("web-app-forbidden")).toBeVisible({
        timeout: 15_000,
      });
      await expect(client.page.getByTestId("project-header")).toHaveCount(0);
      await expect(client.page.getByTestId("workspace-item")).toHaveCount(0);
    } finally {
      await client.close();
    }
  });

  /**
   * ADR-180 D4: `LOCAL_ONLY` is a decision in the table, and a `full` device
   * meets it.
   *
   * After D2/D3 the handler table is the whole allowlist — anything in a page
   * can call `invoke(ns, method, …)` — so the one thing standing between a
   * paired browser and pairing *more* browsers is this set. The reason it
   * matters more than any other refusal is `handlers.ts`'s: a stolen `full`
   * token that can pair is a token that survives its own revocation.
   *
   * Everything here crosses the real socket. `remoteControl` is not in the
   * tab's own refusal list (`src/bridge/unavailable.ts` says so, and why), so
   * the `unavailable:web` below is the *host* answering, from
   * `BridgeServer.dispatch`, not the page declining to ask. `getStatus` on the
   * same namespace is the control: open to a device, and the witness that
   * the refused call changed nothing.
   */
  test("a full device is refused a LOCAL_ONLY method, and the device list does not move", async ({
    app,
    window,
    tempHome,
  }) => {
    await importSeededProject(app, window, tempHome);
    const port = await enableRemoteControl(window);
    const device = await pairDevice(window, {
      label: "full browser",
      capability: "full",
    });
    await closeSettings(window);

    const client = await openWebApp(port, device.token);
    try {
      await expect(
        client.page.getByTestId("project-header").filter({ hasText: PROJECT_NAME }),
      ).toBeVisible({ timeout: 30_000 });

      const before = await devicesSeenBy(client.page);
      expect(before.map((d) => d.label)).toEqual([device.label]);

      const pair = await invokeInPage(client.page, "remoteControl", "pair", [
        "paired by a stolen token",
        "full",
      ]);
      expect(pair).toMatchObject({
        ok: false,
        name: "BridgeUnavailableError",
        code: "unavailable:web",
      });
      expect(pair.message).toContain("remoteControl.pair");

      // Not a special case for pairing: the set refuses the rest of what it
      // names the same way. `resetAll` takes no arguments, so nothing about
      // this refusal can be a validation error in disguise.
      const resetAll = await invokeInPage(
        client.page,
        "keybindings",
        "resetAll",
        [],
      );
      expect(resetAll).toMatchObject({ ok: false, code: "unavailable:web" });

      // Nothing was paired: not by the browser's account, not by the desk's,
      // and not on the settings page a person would look at.
      const after = await devicesSeenBy(client.page);
      expect(after.map((d) => d.id)).toEqual(before.map((d) => d.id));
      const onTheDesk = await devicesSeenBy(window);
      expect(onTheDesk.map((d) => d.id)).toEqual(before.map((d) => d.id));
      await openRemoteControlSettings(window);
      await expect(window.getByTestId("remote-device-row")).toHaveCount(1);
    } finally {
      await client.close();
    }
  });
});
