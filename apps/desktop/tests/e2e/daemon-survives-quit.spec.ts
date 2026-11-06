import fs from "fs";
import path from "path";
import type { ElectronApplication, Page } from "@playwright/test";

import {
  bootWorkspaceWithTerminal,
  expect,
  killApp,
  launchApp,
  openTerminalTab,
  test,
} from "./fixtures";
import { stripAnsi } from "./helpers/ansi";
import {
  activePaneId,
  awaitShellReady,
  paneText,
  runInTerminal,
} from "./helpers/terminal";
import { waitForAppDocument } from "./helpers/window";

/**
 * Quitting the app leaves the local **Daemon** running, and the next launch
 * reattaches to the very sessions it left.
 *
 * Tabs alone prove nothing here: the layout comes back from `layout.json` and
 * a pane's old output from the scrollback on disk, both of which a dead daemon
 * leaves behind. So each tab leaves something only a live session can give
 * back: a loop that keeps counting while the app is gone, and a shell whose
 * pid and a variable never written to disk must be the same after the relaunch.
 *
 * Launches its own app instances rather than taking the fixture's, as
 * `viewport.spec.ts` does; the fixture's `tempHome` teardown still kills the
 * daemon this test leaves running.
 */

const TABS = 3;

/** Cmd+Q: the app's own shutdown runs, unlike `killApp`'s SIGKILL. */
async function quitApp(app: ElectronApplication): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    app.process().once("exit", () => resolve());
  });
  await app.evaluate(({ app }) => app.quit());
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 20_000)),
  ]);
  await killApp(app);
}

/** The pid in the local daemon's pid file, or null if there is none. */
function daemonPid(tempHome: string): number | null {
  const manorDir = path.join(tempHome, ".manor");
  if (!fs.existsSync(manorDir)) return null;
  for (const file of fs.readdirSync(manorDir, {
    recursive: true,
    encoding: "utf8",
  })) {
    if (path.basename(file) !== "terminal-host.pid") continue;
    const pid = Number(
      fs.readFileSync(path.join(manorDir, file), "utf8").trim(),
    );
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }
  return null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function text(window: Page, paneId: string): Promise<string> {
  return stripAnsi(await paneText(window, paneId));
}

function lastTick(seen: string, n: number): number {
  const ticks = [...seen.matchAll(new RegExp(`TICK${n}_(\\d+)`, "g"))].map(
    (m) => Number(m[1]),
  );
  return ticks.length ? Math.max(...ticks) : 0;
}

interface TabState {
  tabId: string;
  paneId: string;
  shellPid: string;
  tick: number;
}

test("terminal sessions keep running in the daemon across a quit and relaunch", async ({
  tempHome,
}) => {
  test.setTimeout(240_000);
  const before: TabState[] = [];
  let daemon: number;

  const first = await launchApp(tempHome);
  try {
    const window = await first.firstWindow();
    await waitForAppDocument(window);
    await bootWorkspaceWithTerminal(first, window, tempHome, "daemon-quit");
    for (let i = 1; i < TABS; i++) await openTerminalTab(window);

    const tabs = window.locator('[data-testid="tab"]');
    await expect.poll(() => tabs.count(), { timeout: 30_000 }).toBe(TABS);

    for (let n = 0; n < TABS; n++) {
      await tabs.nth(n).click();
      await expect(tabs.nth(n)).toHaveAttribute("aria-selected", "true");
      const tabId = (await tabs.nth(n).getAttribute("data-tab-id"))!;
      const paneId = await activePaneId(window);
      await awaitShellReady(window, tempHome, paneId);

      // A variable and a pid live only in the running shell, never on disk.
      await runInTerminal(window, `MARK=tab$((${n}*10+7)); echo "PID=$$"`);
      await expect
        .poll(() => text(window, paneId), { timeout: 15_000 })
        .toMatch(/PID=\d+/);
      const shellPid = /PID=(\d+)/.exec(await text(window, paneId))![1];

      // Output that keeps coming while the app is gone, as an agent's would.
      await runInTerminal(
        window,
        `i=0; while true; do i=$((i+1)); echo TICK${n}_$i; sleep 1; done`,
      );
      await expect
        .poll(async () => lastTick(await text(window, paneId), n), {
          timeout: 15_000,
        })
        .toBeGreaterThanOrEqual(2);
      before.push({ tabId, paneId, shellPid, tick: 0 });
    }

    // The newest tick of each, as late as possible before the quit.
    for (let n = 0; n < TABS; n++) {
      await tabs.nth(n).click();
      before[n].tick = lastTick(await text(window, before[n].paneId), n);
    }

    await expect.poll(() => daemonPid(tempHome), { timeout: 10_000 }).not.toBeNull();
    daemon = daemonPid(tempHome)!;
    expect(isAlive(daemon)).toBe(true);
    await window.screenshot({ path: test.info().outputPath("before-quit.png") });
  } finally {
    await quitApp(first);
  }

  // The app is gone; the daemon is not.
  expect(isAlive(daemon!)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect(isAlive(daemon!)).toBe(true);

  const second = await launchApp(tempHome);
  try {
    const window = await second.firstWindow();
    await waitForAppDocument(window);

    // Same daemon, not a new one started in its place.
    expect(daemonPid(tempHome)).toBe(daemon!);

    const tabs = window.locator('[data-testid="tab"]');
    await expect.poll(() => tabs.count(), { timeout: 30_000 }).toBe(TABS);

    for (let n = 0; n < TABS; n++) {
      const was = before[n];
      await expect(tabs.nth(n)).toHaveAttribute("data-tab-id", was.tabId);
      await tabs.nth(n).click();
      await expect(tabs.nth(n)).toHaveAttribute("aria-selected", "true");
      await expect.poll(() => activePaneId(window)).toBe(was.paneId);

      // It counted while the app was away, and is counting still.
      await expect
        .poll(async () => lastTick(await text(window, was.paneId), n), {
          timeout: 20_000,
        })
        .toBeGreaterThan(was.tick + 3);

      // The same shell: its pid, and the variable set before the quit.
      await window
        .locator('[data-testid="terminal-pane"]:visible')
        .first()
        .click();
      await window.keyboard.press("Control+c");
      await runInTerminal(window, `echo "SAME=$$:$MARK"`);
      await expect
        .poll(() => text(window, was.paneId), { timeout: 15_000 })
        .toContain(`SAME=${was.shellPid}:tab${n * 10 + 7}`);
    }

    expect(isAlive(daemon!)).toBe(true);
    await window.screenshot({ path: test.info().outputPath("relaunched.png") });
  } finally {
    await killApp(second);
  }
});
