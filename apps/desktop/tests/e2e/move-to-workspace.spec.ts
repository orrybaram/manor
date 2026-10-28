import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import type { Locator, Page } from "@playwright/test";

import {
  createWorkspace,
  expect,
  importSeededProject,
  killApp,
  launchApp,
  openTerminalTab,
  test,
} from "./fixtures";
import { FAKE_AGENT, FAKE_AGENT_HUSH } from "./helpers/fake-agent";
import {
  postRoute,
  sendToSession,
  splitPane,
  waitForAgentStatus,
  waitForVisibleSession,
} from "./helpers/local-api";
import { awaitShellReady, paneText, runInTerminal } from "./helpers/terminal";
import { waitForAppDocument } from "./helpers/window";

/**
 * Moving a pane or a tab to another workspace of the same project: by
 * dragging it onto the sidebar, from the right-click picker, and from the CLI.
 * Whatever the route, the session is the same one afterwards — its scrollback
 * is still there and it still takes input — and the layout survives a restart.
 *
 * `MANOR_E2E_EVIDENCE=<dir>` writes screenshots (dark, then light) and the
 * CLI's output there.
 */

const EVIDENCE = process.env.MANOR_E2E_EVIDENCE;
const LIGHT_THEME = "E2E Light";
const CLI = path.join(__dirname, "..", "..", "dist-electron", "manor-cli.js");

async function shot(window: Page, name: string): Promise<void> {
  if (!EVIDENCE) return;
  // Menus and the picker fade in; let them settle.
  await window.waitForTimeout(250);
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await window.screenshot({ path: path.join(EVIDENCE, `${name}.png`) });
}

function installLightTheme(tempHome: string): void {
  const body = [
    ...["#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781"]
      .map((c, i) => `palette = ${i}=${c}`),
    "background = #ffffff",
    "foreground = #1f2328",
    "cursor-color = #0969da",
    "",
  ].join("\n");
  for (const dir of [
    path.join(tempHome, "Library", "Application Support", "ghostty", "themes"),
    path.join(tempHome, ".config", "ghostty", "themes"),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, LIGHT_THEME), body);
  }
}

function row(window: Page, name: string): Locator {
  return window.locator('[data-testid="workspace-item"]', { hasText: name }).first();
}

async function pathOf(window: Page, name: string): Promise<string> {
  const p = await row(window, name).getAttribute("data-workspace-path");
  expect(p).toBeTruthy();
  return p!;
}

function statusBar(window: Page, paneId: string): Locator {
  return window.locator(`[data-pane-id="${paneId}"] [draggable]`).first();
}

async function visiblePaneIds(window: Page): Promise<string[]> {
  return window
    .locator('[data-testid="workspace-pane"]:visible')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-pane-id") ?? ""));
}

/**
 * A native HTML5 drag, by mouse: Chromium starts the drag after the first
 * moves and runs dragover on every step after that. `hover` runs mid-drag,
 * with the cursor over the target, before the drop.
 */
async function dragOnto(
  window: Page,
  source: Locator,
  target: Locator,
  hover?: () => Promise<void>,
): Promise<void> {
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  await window.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await window.mouse.down();
  await window.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 + 5, { steps: 5 });
  await window.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
  await window.mouse.move(to.x + to.width / 2 + 2, to.y + to.height / 2, { steps: 2 });
  if (hover) await hover();
  await window.mouse.up();
}

async function layoutOf(
  request: import("@playwright/test").APIRequestContext,
  tempHome: string,
  workspacePath: string,
): Promise<string[]> {
  const port = fs.readFileSync(path.join(tempHome, ".manor", "webview-server-port"), "utf-8").trim();
  const res = await request.get(
    `http://127.0.0.1:${port}/panes?workspacePath=${encodeURIComponent(workspacePath)}`,
  );
  if (!res.ok()) return [];
  const snap = (await res.json()) as { tabs: { panes: { paneId: string }[] }[] };
  return snap.tabs.flatMap((t) => t.panes.map((p) => p.paneId));
}

test("a pane and a tab move to another workspace by drag, picker and CLI, and stay there after a restart", async ({
  tempHome,
  request,
}) => {
  test.setTimeout(240_000);
  installLightTheme(tempHome);
  let app = await launchApp(tempHome);
  let window = await app.firstWindow();
  await waitForAppDocument(window);

  try {
    await importSeededProject(app, window, tempHome);
    await createWorkspace(window, "ws-alpha");
    await openTerminalTab(window);
    const [paneA] = await visiblePaneIds(window);
    await awaitShellReady(window, tempHome, paneA);
    await runInTerminal(window, "echo MOVE-MARKER-$((40+2))");
    await expect.poll(() => paneText(window, paneA)).toContain("MOVE-MARKER-42");
    const { paneId: paneB } = await splitPane(request, tempHome, {
      paneId: paneA,
      direction: "horizontal",
    });
    await expect.poll(() => visiblePaneIds(window)).toHaveLength(2);

    await createWorkspace(window, "ws-beta");
    await createWorkspace(window, "ws-gamma");
    const alpha = await pathOf(window, "ws-alpha");
    const beta = await pathOf(window, "ws-beta");
    const gamma = await pathOf(window, "ws-gamma");
    await row(window, "ws-alpha").click();
    await expect.poll(() => visiblePaneIds(window)).toEqual([paneA, paneB]);

    // ── 1. Drag one pane of a split onto ws-beta's row ──────────────────────
    await dragOnto(window, statusBar(window, paneA), row(window, "ws-beta"), async () => {
      await expect(row(window, "ws-beta")).toHaveAttribute("data-move-drop", "valid");
      await expect(row(window, "ws-alpha")).toHaveAttribute("data-move-drop", "invalid");
      await shot(window, "01-pane-drag-dark");
    });
    await expect(row(window, "ws-beta")).toHaveAttribute("aria-current", "true");
    await expect.poll(() => visiblePaneIds(window)).toEqual([paneA]);
    await expect(row(window, "ws-beta")).not.toHaveAttribute("data-move-drop");
    // Same session: the old output is there, and it still takes input.
    expect(await paneText(window, paneA)).toContain("MOVE-MARKER-42");
    await runInTerminal(window, "echo AFTER-$((1+1))-MOVE");
    await expect.poll(() => paneText(window, paneA)).toContain("AFTER-2-MOVE");
    expect(await layoutOf(request, tempHome, alpha)).toEqual([paneB]);
    expect(await layoutOf(request, tempHome, beta)).toEqual([paneA]);
    await shot(window, "02-pane-landed-dark");

    // ── 2. Drag a whole split tab onto ws-gamma's row ───────────────────────
    await row(window, "ws-alpha").click();
    await expect.poll(() => visiblePaneIds(window)).toEqual([paneB]);
    const { paneId: paneC } = await splitPane(request, tempHome, {
      paneId: paneB,
      direction: "vertical",
    });
    await expect.poll(() => visiblePaneIds(window)).toEqual([paneB, paneC]);
    const alphaTab = window.locator('[data-testid="tab"]:visible').first();
    await dragOnto(window, alphaTab, row(window, "ws-gamma"), async () => {
      await expect(row(window, "ws-gamma")).toHaveAttribute("data-move-drop", "valid");
      await shot(window, "03-tab-drag-dark");
    });
    await expect(row(window, "ws-gamma")).toHaveAttribute("aria-current", "true");
    await expect.poll(() => visiblePaneIds(window)).toEqual([paneB, paneC]);
    expect(await layoutOf(request, tempHome, alpha)).toEqual([]);
    expect(await layoutOf(request, tempHome, gamma)).toEqual([paneB, paneC]);
    await shot(window, "04-tab-landed-dark");

    // ── 3. Dropping on the workspace a pane is already in changes nothing ───
    await dragOnto(window, statusBar(window, paneC), row(window, "ws-gamma"));
    expect(await layoutOf(request, tempHome, gamma)).toEqual([paneB, paneC]);

    // ── 4. Right-click picker, for a pane ───────────────────────────────────
    await statusBar(window, paneC).click({ button: "right" });
    await shot(window, "05-pane-menu-dark");
    await window.getByTestId("move-to-workspace-item").click();
    const picker = window.getByTestId("move-to-workspace-picker");
    await expect(picker).toBeVisible();
    // Only the project's other workspaces: never the one the pane is in.
    await expect(picker.getByTestId("move-to-workspace-target")).toHaveCount(3);
    await expect(picker).not.toContainText("ws-gamma");
    await shot(window, "06-picker-dark");
    await window.keyboard.type("beta");
    await expect(picker.getByTestId("move-to-workspace-target")).toHaveCount(1);
    await shot(window, "07-picker-filtered-dark");
    await window.keyboard.press("Enter");
    await expect(picker).not.toBeVisible();
    await expect(row(window, "ws-beta")).toHaveAttribute("aria-current", "true");
    expect(await layoutOf(request, tempHome, beta)).toEqual([paneA, paneC]);
    expect(await layoutOf(request, tempHome, gamma)).toEqual([paneB]);

    // ── 5. Right-click picker, for a tab ────────────────────────────────────
    const betaTab = window.locator('[data-testid="tab"]:visible').first();
    await betaTab.click({ button: "right" });
    await shot(window, "08-tab-menu-dark");
    await window.getByTestId("move-to-workspace-item").click();
    await expect(picker).toBeVisible();
    await window.keyboard.type("alpha");
    await window.keyboard.press("Enter");
    await expect(row(window, "ws-alpha")).toHaveAttribute("aria-current", "true");
    expect(await layoutOf(request, tempHome, alpha)).toEqual([paneA]);
    expect(await layoutOf(request, tempHome, beta)).toEqual([paneC]);

    // ── 6. Light theme: the drag state and the picker ───────────────────────
    await window.evaluate((n) => window.electronAPI.theme.setSelected(n), LIGHT_THEME);
    await window.waitForTimeout(1_000);
    await statusBar(window, paneA).click({ button: "right" });
    await shot(window, "09-pane-menu-light");
    await window.getByTestId("move-to-workspace-item").click();
    await expect(picker).toBeVisible();
    await shot(window, "10-picker-light");
    await window.keyboard.press("Escape");
    await expect(picker).not.toBeVisible();
    await dragOnto(window, statusBar(window, paneA), row(window, "ws-gamma"), async () => {
      await shot(window, "11-pane-drag-light");
    });
    await expect(row(window, "ws-gamma")).toHaveAttribute("aria-current", "true");
    await shot(window, "12-pane-landed-light");
    expect(await layoutOf(request, tempHome, gamma)).toEqual([paneB, paneA]);

    // ── 7. CLI ──────────────────────────────────────────────────────────────
    const cli = (args: string[]): string => {
      try {
        return execFileSync("node", [CLI, ...args], {
          // Only the test app: a MANOR_* variable from the shell running the
          // suite (a Manor pane) would point the CLI at that Manor instead.
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([k]) => !k.startsWith("MANOR_")),
            ),
            HOME: tempHome,
          },
          encoding: "utf-8",
        });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; status?: number };
        return `${e.stdout ?? ""}${e.stderr ?? ""}(exit ${e.status})`;
      }
    };
    const transcript: string[] = [];
    const run = (args: string[]) => {
      const out = cli(args);
      transcript.push(`$ manor ${args.join(" ")}\n${out.trim()}\n`);
      return out;
    };
    const ok = run(["move-pane-to-workspace", "--pane-id", paneB, "--workspace-path", beta]);
    expect(ok).toContain(paneB);
    expect(await layoutOf(request, tempHome, beta)).toEqual([paneC, paneB]);
    const tabId = (await (async () => {
      const port = fs.readFileSync(path.join(tempHome, ".manor", "webview-server-port"), "utf-8").trim();
      const res = await request.get(`http://127.0.0.1:${port}/panes?workspacePath=${encodeURIComponent(beta)}`);
      const snap = (await res.json()) as { tabs: { tabId: string; panes: { paneId: string }[] }[] };
      return snap.tabs.find((t) => t.panes.some((p) => p.paneId === paneB))!.tabId;
    })());
    run(["move-tab-to-workspace", "--tab-id", tabId, "--workspace-path", alpha]);
    expect(await layoutOf(request, tempHome, alpha)).toEqual([paneB]);
    const bad = run(["move-pane-to-workspace", "--pane-id", paneB, "--workspace-path", "/nowhere/else"]);
    expect(bad.toLowerCase()).toMatch(/unknown workspace|error/);
    expect(await layoutOf(request, tempHome, alpha)).toEqual([paneB]);
    const same = await postRoute(request, tempHome, `/panes/${paneB}/move-to-workspace`, {
      workspacePath: alpha,
    });
    expect(same.status).toBe(400);
    transcript.push(`POST /panes/${paneB}/move-to-workspace {workspacePath: ws-alpha} → ${same.status} ${JSON.stringify(same.body)}\n`);
    if (EVIDENCE) fs.writeFileSync(path.join(EVIDENCE, "cli.txt"), transcript.join("\n"));
  } finally {
    await killApp(app);
  }

  // ── 8. The moves survive a restart, on the same sessions ─────────────────
  app = await launchApp(tempHome);
  try {
    window = await app.firstWindow();
    await waitForAppDocument(window);
    await row(window, "ws-gamma").click();
    const panes = await visiblePaneIds(window);
    expect(panes).toHaveLength(1);
    await expect.poll(() => paneText(window, panes[0]), { timeout: 20_000 }).toContain("AFTER-2-MOVE");
    await shot(window, "13-after-restart");
  } finally {
    // Never mask the step that failed with a shutdown error.
    await killApp(app).catch((err) => console.warn("killApp after restart:", err));
  }
});

test("an agent's pane keeps its status and takes its sidebar dot to the workspace it moves to", async ({
  tempHome,
  request,
}) => {
  test.setTimeout(150_000);
  const app = await launchApp(tempHome);
  try {
    const window = await app.firstWindow();
    await waitForAppDocument(window);
    await importSeededProject(app, window, tempHome);
    await createWorkspace(window, "ws-beta");
    await createWorkspace(window, "ws-alpha");
    await openTerminalTab(window);
    const [paneId] = await visiblePaneIds(window);
    await awaitShellReady(window, tempHome, paneId);
    await runInTerminal(window, `"${FAKE_AGENT}" move-agent`);
    const session = await waitForVisibleSession(request, tempHome, { name: "move-agent" });

    // Look elsewhere while the turn ends, so ws-alpha's dot is an unread "done".
    await row(window, "local").click();
    await sendToSession(request, tempHome, session.id, FAKE_AGENT_HUSH);
    await waitForAgentStatus(request, tempHome, session.id, "responded");
    const indicator = (name: string) => row(window, name).getByTestId("workspace-indicator");
    await expect(indicator("ws-alpha")).toBeVisible({ timeout: 10_000 });
    await expect(indicator("ws-beta")).toHaveCount(0);
    await shot(window, "14-agent-before-move");

    // The window isn't showing ws-alpha, so the move doesn't take it along.
    const res = await postRoute(request, tempHome, `/panes/${paneId}/move-to-workspace`, {
      workspacePath: await pathOf(window, "ws-beta"),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ followed: false });
    await expect(row(window, "local")).toHaveAttribute("aria-current", "true");

    // Same agent, same status; its record and its dot are in ws-beta now.
    const moved = await waitForAgentStatus(request, tempHome, session.id, "responded");
    expect(moved.workspacePath).toBe(await pathOf(window, "ws-beta"));
    await expect(indicator("ws-beta")).toBeVisible({ timeout: 10_000 });
    await expect(indicator("ws-alpha")).toHaveCount(0);
    await shot(window, "15-agent-after-move");
  } finally {
    await killApp(app).catch((err) => console.warn("killApp:", err));
  }
});
