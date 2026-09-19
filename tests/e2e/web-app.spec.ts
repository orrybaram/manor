import fs from "fs";
import path from "path";
import { expect, type Page } from "@playwright/test";

import {
  createWorkspace,
  importSeededProject,
  openTerminalTab,
  test,
} from "./fixtures";
import { FAKE_AGENT, FAKE_AGENT_BANNER, FAKE_AGENT_ECHO } from "./helpers/fake-agent";
import { Filmstrip } from "./helpers/filmstrip";
import { readSessionMeta, waitForVisibleSession } from "./helpers/local-api";
import { openWebApp } from "./helpers/phone";
import {
  closeSettings,
  enableRemoteControl,
  pairDevice,
} from "./helpers/settings";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";

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
    // pane the two viewers shared, and nothing else.
    const entries = auditEntries(tempHome);
    expect(entries.some((e) => e.route === "pty.write")).toBe(false);

    const bridgeEntries = entries.filter((e) => e.transport === "bridge");
    expect(bridgeEntries.map((e) => e.route)).toContain("pty.create");
    for (const entry of bridgeEntries) {
      expect(["pty.create", "agents.setPaneContext"]).toContain(entry.route);
      expect(entry.target).toBe(desktopPaneId);
      expect(entry.outcome).toBe("sent");
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
});
