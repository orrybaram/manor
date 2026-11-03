import fs from "fs";
import path from "path";

import type { APIRequestContext, Page, TestInfo } from "@playwright/test";

import { expect, importSeededProject, test } from "./fixtures";
import {
  FAKE_AGENT,
  FAKE_AGENT_EXIT,
  FAKE_AGENT_HUSH,
  FAKE_AGENT_LOG_ENV,
  FAKE_AGENT_SLOW_HUSH,
} from "./helpers/fake-agent";
import { localApiHeaders, localApiUrl } from "./helpers/local-api";
import { openSettings } from "./helpers/settings";
import { useTheme } from "./helpers/theme";

/**
 * A reused workspace's runs in one agent pane, through the app's local API
 * with the suite's fake agent: runs stay in the pane, a run skips while the
 * agent needs input, works or is just sent to, and an agent that exited or a
 * tab that closed gets a new tab the next run reuses.
 * Then the editor's chip and run history, photographed dark and light.
 *
 * Screenshots go to the test's output dir, and to $SHOT_DIR when it is set.
 */

interface Run {
  outcome: string;
  reason?: string;
  paneId?: string;
  sentToPane?: boolean;
}

async function api<T>(
  request: APIRequestContext,
  tempHome: string,
  method: "GET" | "POST" | "DELETE",
  route: string,
  data?: Record<string, unknown>,
): Promise<T> {
  const res = await request.fetch(localApiUrl(tempHome, route), {
    method,
    headers: localApiHeaders(tempHome),
    data: data ?? (method === "GET" ? undefined : {}),
    timeout: 60_000,
  });
  if (!res.ok()) throw new Error(`${method} ${route} → ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

async function shot(window: Page, testInfo: TestInfo, name: string): Promise<void> {
  const file = testInfo.outputPath(`${name}.png`);
  await window.screenshot({ path: file, animations: "disabled" });
  const dir = process.env.SHOT_DIR;
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, path.join(dir, `${name}.png`));
  }
}

test.describe("Automations: one agent pane across runs", () => {
  test.setTimeout(240_000);

  test("runs stay in the pane, skip while it's occupied, and survive its loss", async ({
    window,
    app,
    tempHome,
    request,
  }, testInfo) => {
    await importSeededProject(app, window, tempHome);
    await expect(window.getByTestId("notifications-bell")).toBeVisible({ timeout: 30_000 });

    const call = <T,>(method: "GET" | "POST" | "DELETE", route: string, data?: Record<string, unknown>) =>
      api<T>(request, tempHome, method, route, data);

    const projects = await call<Array<{ id: string; path: string; workspaces: { path: string }[] }>>("GET", "/projects");
    const project = projects.find((p) => p.path === path.join(tempHome, "test-project")) ?? projects[0];
    const log = path.join(tempHome, "fake-agent.log");
    // Named as the real CLI is: Manor tells an agent at rest from a program
    // the user runs in the pane by its foreground process's name.
    const claude = path.join(tempHome, "fake-bin", "claude");
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.symlinkSync(FAKE_AGENT, claude);
    await call("POST", `/projects/${project.id}/update`, {
      agentCommand: `FAKE_AGENT_CLEARS=1 ${FAKE_AGENT_LOG_ENV}="${log}" "${claude}"`,
    });
    const logged = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf-8").trim().split("\n") : []);

    const automation = await call<{ id: string }>("POST", "/automations", {
      name: "PR screener",
      schedule: { cron: "0 * * * *", timezone: "UTC" },
      projectId: project.id,
      prompt: FAKE_AGENT_HUSH,
      agentKind: "claude",
      workspace: { mode: "reuse", workspacePath: project.workspaces[0].path, pane: "fresh" },
      enabled: false,
    });
    const runNow = () => call<Run>("POST", `/automations/${automation.id}/run`);
    const status = async (paneId: string): Promise<string | null> => {
      const detail = await call<{ runs: Array<Run & { status: string | null }> }>(
        "GET",
        `/automations/${automation.id}`,
      );
      return detail.runs.find((r) => r.paneId === paneId && r.outcome === "started")?.status ?? null;
    };
    /** Past the "just sent" window, so a run is judged by what the agent is doing. */
    const settle = () => window.waitForTimeout(5_500);

    // The first run has no pane: it opens one. The fake agent starts at a prompt.
    const first = await runNow();
    expect(first).toMatchObject({ outcome: "started" });
    expect(first.sentToPane).toBeUndefined();
    const paneId = first.paneId!;

    await expect.poll(() => status(paneId), { timeout: 30_000 }).toBe("requires_input");
    await settle();
    expect(await runNow()).toMatchObject({
      outcome: "skipped",
      reason: "waiting-for-input",
      detail: "The agent is waiting for input",
      paneId,
    });
    expect(logged()).toEqual([]);

    // Answered, it is at its prompt: fresh clears, then sends, in that pane.
    await call("POST", "/sessions/send", { target: paneId, text: FAKE_AGENT_HUSH });
    await expect.poll(() => status(paneId), { timeout: 15_000 }).toBe("responded");
    await settle();
    expect(await runNow()).toMatchObject({ outcome: "started", sentToPane: true, paneId });
    await expect.poll(logged, { timeout: 15_000 }).toEqual([FAKE_AGENT_HUSH, "/clear", FAKE_AGENT_HUSH]);

    // Same pane, keep context: only the prompt.
    await call("POST", `/automations/${automation.id}/update`, { workspace: { pane: "keep" } });
    await expect.poll(() => status(paneId), { timeout: 15_000 }).toBe("responded");
    await settle();
    expect(await runNow()).toMatchObject({ outcome: "started", sentToPane: true, paneId });
    await expect.poll(logged, { timeout: 15_000 }).toEqual([
      FAKE_AGENT_HUSH,
      "/clear",
      FAKE_AGENT_HUSH,
      FAKE_AGENT_HUSH,
    ]);

    // The agent exits to its shell: a new tab, and the prompt never goes to the shell.
    await call("POST", "/sessions/send", { target: paneId, text: FAKE_AGENT_EXIT });
    await window.waitForTimeout(3_000);
    await settle();
    const replaced = await runNow();
    expect(replaced.outcome).toBe("started");
    expect(replaced.sentToPane).toBeUndefined();
    expect(replaced.paneId).not.toBe(paneId);

    // And later runs use the new tab.
    const newPane = replaced.paneId!;
    await expect.poll(() => status(newPane), { timeout: 30_000 }).toBe("requires_input");
    await call("POST", "/sessions/send", { target: newPane, text: FAKE_AGENT_HUSH });
    await expect.poll(() => status(newPane), { timeout: 15_000 }).toBe("responded");
    await settle();
    expect(await runNow()).toMatchObject({ outcome: "started", sentToPane: true, paneId: newPane });

    // A second click right after: it hasn't reported its turn yet.
    expect(await runNow()).toMatchObject({
      outcome: "skipped",
      reason: "agent-starting",
      detail: "The agent is still starting",
      paneId: newPane,
    });

    // Mid-turn, Run now records a skip and types nothing.
    await settle();
    await call("POST", "/sessions/send", { target: newPane, text: FAKE_AGENT_SLOW_HUSH });
    await expect.poll(() => status(newPane), { timeout: 4_000, intervals: [100] }).toBe("thinking");
    const before = logged().length;
    expect(await runNow()).toMatchObject({
      outcome: "skipped",
      reason: "still-working",
      detail: "The previous run is still working",
      paneId: newPane,
    });
    await expect.poll(() => status(newPane), { timeout: 15_000 }).toBe("responded");
    expect(logged().length).toBe(before);

    // The tab closed: a new one, which the run after uses.
    await call("DELETE", `/panes/${newPane}`);
    const reopened = await runNow();
    expect(reopened.outcome).toBe("started");
    expect(reopened.sentToPane).toBeUndefined();
    expect(reopened.paneId).not.toBe(newPane);
    const thirdPane = reopened.paneId!;
    await expect.poll(() => status(thirdPane), { timeout: 30_000 }).toBe("requires_input");
    await call("POST", "/sessions/send", { target: thirdPane, text: FAKE_AGENT_HUSH });
    await expect.poll(() => status(thirdPane), { timeout: 15_000 }).toBe("responded");
    await settle();
    expect(await runNow()).toMatchObject({ outcome: "started", sentToPane: true, paneId: thirdPane });

    // The editor: the chip, its menu, and the runs above in its history.
    await openSettings(window);
    await window.getByTestId("settings-nav-automations").click();
    await window.getByText("PR screener").first().click();
    await expect(window.getByTestId("automation-chip-pane")).toHaveText(/same pane, keep context/);
    await shot(window, testInfo, "same-pane-dark");
    await useTheme(window, "Catppuccin Latte");
    await shot(window, testInfo, "same-pane-light");
    await useTheme(window, "Catppuccin Mocha");
    await window.getByTestId("automation-chip-pane").click();
    await expect(window.getByTestId("automation-pane-fresh")).toBeVisible();
    await shot(window, testInfo, "same-pane-menu-dark");
    await useTheme(window, "Catppuccin Latte");
    await shot(window, testInfo, "same-pane-menu-light");
    await useTheme(window, "Catppuccin Mocha");
    await window.getByTestId("automation-pane-fresh").click();
    await expect(window.getByTestId("automation-chip-pane")).toHaveText(/same pane, fresh/);

    // The chip belongs to a reused workspace only.
    await window.getByTestId("automation-chip-workspace").click();
    await window.getByTestId("automation-workspace-new").click();
    await expect(window.getByTestId("automation-chip-pane")).toHaveCount(0);
    await window.getByTestId("automation-chip-workspace").click();
    await window.locator('[data-testid^="automation-workspace-reuse-"]').first().click();
    await expect(window.getByTestId("automation-chip-pane")).toHaveText(/new tab each run/);
  });
});
