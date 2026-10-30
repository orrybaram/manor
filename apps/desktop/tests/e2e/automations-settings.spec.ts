import { execSync } from "child_process";
import fs from "fs";
import path from "path";

import type { APIRequestContext, ElectronApplication, Page, TestInfo } from "@playwright/test";

import { expect, importSeededProject, test } from "./fixtures";
import { FAKE_AGENT } from "./helpers/fake-agent";
import { localApiHeaders, localApiUrl } from "./helpers/local-api";
import { closeSettings, openSettings } from "./helpers/settings";

/**
 * Settings → Automations, photographed: the list, an automation's own page
 * with a run in its history, the schedule chip's menu, a new automation, and
 * the bell holding the "<name> ran" notification — in the default dark theme
 * and a light one, at desk width and at phone width (a window below the
 * 768 px breakpoint, so `useLayoutMode()` reads "phone").
 *
 * Local host only. Everything is seeded through the app's local HTTP API
 * (`electron/routes/automations.ts`, `electron/routes/projects.ts`); the
 * project's agent command is the suite's fake agent, so Run now starts a
 * real run whose workspace lands in the project's Automations folder without
 * any real agent CLI.
 *
 * Screenshots go to the test's output dir, and are copied into $SHOT_DIR when
 * it is set.
 */

const DESK = { width: 1280, height: 800 };
/** The window's minWidth is 400 (`electron/window.ts`): narrower is clamped. */
const PHONE = { width: 400, height: 844 };
const LIGHT_THEME = "E2E Latte";
const DARK_THEME = "__default__";

type Theme = "dark" | "light";
type Width = "desk" | "phone";

interface Project {
  id: string;
  name: string;
  path: string;
  workspaces: { path: string }[];
}

interface AutomationView {
  id: string;
  name: string;
}

interface RunView {
  id: string;
  outcome: string;
  reason?: string;
  detail?: string;
  workspacePath?: string;
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

/** Catppuccin Latte's palette as a Ghostty theme file, where the theme manager looks. */
function installLightTheme(tempHome: string): void {
  const palette = [
    "#5c5f77", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#acb0be",
    "#6c6f85", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#bcc0cc",
  ];
  const body = [
    ...palette.map((c, i) => `palette = ${i}=${c}`),
    "background = #eff1f5",
    "foreground = #4c4f69",
    "cursor-color = #dc8a78",
    "selection-background = #acb0be",
    "selection-foreground = #4c4f69",
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

async function selectTheme(window: Page, theme: Theme): Promise<void> {
  const bg = () =>
    window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
  const before = await bg();
  await window.evaluate(
    (name) => window.electronAPI.theme.setSelected(name),
    theme === "light" ? LIGHT_THEME : DARK_THEME,
  );
  if (theme === "light") {
    await expect.poll(bg, { timeout: 10_000 }).toBe("#eff1f5");
  } else if (before === "#eff1f5") {
    await expect.poll(bg, { timeout: 10_000 }).not.toBe("#eff1f5");
  }
  await window.waitForTimeout(500);
}

async function setWidth(app: ElectronApplication, window: Page, width: Width): Promise<void> {
  const size = width === "phone" ? PHONE : DESK;
  await app.evaluate(({ BrowserWindow }, s) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win?.isMaximized()) win.unmaximize();
    win?.setSize(s.width, s.height);
  }, size);
  await expect
    .poll(() => window.evaluate(() => document.documentElement.dataset.layout), { timeout: 10_000 })
    .toBe(width);
  await window.waitForTimeout(600);
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

/** Settings open on the Automations list (not an automation's page). */
async function openAutomationsList(window: Page): Promise<void> {
  await openSettings(window);
  const back = window.getByTestId("automation-back");
  if (await back.isVisible().catch(() => false)) await back.click();
  const list = window.getByTestId("automations-page");
  if (!(await list.isVisible().catch(() => false))) {
    await window.getByTestId("settings-nav-automations").click();
  }
  await expect(list).toBeVisible({ timeout: 10_000 });
}

function makeRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# scratch\n");
  const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "ignore" });
  run("git init");
  run('git config user.email "test@manor-e2e.local"');
  run('git config user.name "Manor E2E"');
  run("git checkout -b main");
  run("git add README.md");
  run('git commit -m "initial commit"');
}

test.describe("Settings → Automations screenshots", () => {
  test.setTimeout(300_000);

  test("list, page, schedule menu, new and bell, dark and light, desk and phone", async ({
    app,
    window,
    tempHome,
    request,
  }, testInfo) => {
    installLightTheme(tempHome);
    await setWidth(app, window, "desk");

    // The project, through the onboarding screen as every other spec adds it.
    await importSeededProject(app, window, tempHome);
    await expect(window.getByTestId("notifications-bell")).toBeVisible({ timeout: 30_000 });

    const projects = await api<Project[]>(request, tempHome, "GET", "/projects");
    const project = projects.find((p) => p.path === path.join(tempHome, "test-project")) ?? projects[0];
    if (!project) throw new Error("GET /projects listed no seeded project");
    const mainWorkspace = project.workspaces[0]?.path ?? project.path;

    await api(request, tempHome, "POST", `/projects/${project.id}/update`, {
      agentCommand: `"${FAKE_AGENT}"`,
    });

    const create = (body: Record<string, unknown>) =>
      api<AutomationView>(request, tempHome, "POST", "/automations", {
        agentKind: "claude",
        projectId: project.id,
        ...body,
      });

    const triage = await create({
      name: "Morning PR triage",
      schedule: { cron: "0 9 * * 1-5", timezone: "Europe/London" },
      prompt:
        "Look through the open pull requests on this repo. For each one waiting on review, summarise what changed and flag anything risky.",
      workspace: { mode: "new", keepLast: 5 },
      enabled: true,
    });
    const ci = await create({
      name: "Watch CI on main",
      schedule: { cron: "15 * * * *", timezone: "UTC" },
      prompt: "Check the latest CI run on main. If it failed, find the failing test and propose a fix.",
      workspace: { mode: "reuse", workspacePath: mainWorkspace },
      enabled: true,
    });
    const changelog = await create({
      name: "Weekly changelog draft",
      schedule: { cron: "0 16 * * 5", timezone: "Europe/London" },
      prompt: "Draft a changelog entry from this week's merged commits.",
      workspace: { mode: "new" },
      enabled: false,
    });

    // Optional: an automation whose project has since been removed.
    let orphanId: string | null = null;
    try {
      const otherDir = path.join(tempHome, "old-service");
      makeRepo(otherDir);
      const other = await api<Project>(request, tempHome, "POST", "/projects", {
        name: "old-service",
        path: otherDir,
      });
      await api(request, tempHome, "POST", `/projects/${other.id}/update`, { setupComplete: true });
      const orphan = await create({
        name: "Nightly dependency bump",
        projectId: other.id,
        schedule: { cron: "0 2 * * *", timezone: "UTC" },
        prompt: "Bump outdated dependencies and open a PR.",
        workspace: { mode: "new" },
        enabled: false,
      });
      await api(request, tempHome, "DELETE", `/projects/${other.id}`);
      const still = await api<AutomationView[]>(request, tempHome, "GET", "/automations");
      orphanId = still.some((a) => a.id === orphan.id) ? orphan.id : null;
    } catch (err) {
      console.warn("[automations-settings] skipped the project-missing automation:", err);
    }
    // A setup wizard for the added project, if one opened, is not in the shots.
    const wizard = window.getByTestId("project-setup-wizard");
    if (await wizard.isVisible().catch(() => false)) await window.keyboard.press("Escape");

    // Run now, once: a started run with a workspace in the Automations folder.
    const run = await api<RunView>(request, tempHome, "POST", `/automations/${triage.id}/run`);
    console.log(`[automations-settings] run ${run.id}: ${run.outcome}`, run.reason ?? "", run.detail ?? "", run.workspacePath ?? "");
    expect(run.outcome, `Run now: ${run.reason ?? ""} ${run.detail ?? ""}`).toBe("started");

    const rowOf = (id: string) => window.getByTestId(`automations-row-${id}`);

    for (const theme of ["dark", "light"] as const) {
      await closeSettings(window);
      await setWidth(app, window, "desk");
      await selectTheme(window, theme);

      // The list.
      await openAutomationsList(window);
      for (const a of [triage, ci, changelog]) {
        await expect(rowOf(a.id)).toBeVisible({ timeout: 15_000 });
      }
      if (orphanId) await expect(rowOf(orphanId)).toBeVisible({ timeout: 15_000 });
      await expect(window.getByTestId("automations-host-local")).toBeVisible();
      await expect(rowOf(triage.id)).toContainText("Weekdays at 09:00");
      await expect(rowOf(changelog.id)).toContainText("Paused");
      await shot(window, testInfo, `automations-list-${theme}-desk`);

      await setWidth(app, window, "phone");
      await expect(rowOf(triage.id)).toBeVisible({ timeout: 10_000 });
      await shot(window, testInfo, `automations-list-${theme}-phone`);
      await setWidth(app, window, "desk");

      // Morning PR triage's page, with its run in the history.
      await rowOf(triage.id).click();
      const detail = window.getByTestId("automation-detail");
      await expect(detail).toBeVisible({ timeout: 10_000 });
      await expect(window.getByTestId("automation-name")).toHaveValue("Morning PR triage", { timeout: 10_000 });
      await expect(window.getByTestId("automation-chip-schedule")).toContainText(/weekdays/i);
      await expect(window.getByTestId("automation-runs")).toBeVisible({ timeout: 10_000 });
      await expect(window.getByTestId(`automation-run-${run.id}`)).toBeVisible({ timeout: 15_000 });
      await expect(window.getByTestId("automation-next-runs")).toBeVisible();
      await shot(window, testInfo, `automation-detail-${theme}-desk`);

      await setWidth(app, window, "phone");
      await expect(window.getByTestId(`automation-run-${run.id}`)).toBeAttached({ timeout: 10_000 });
      await shot(window, testInfo, `automation-detail-${theme}-phone`);
      await setWidth(app, window, "desk");

      // The schedule chip's menu.
      await window.getByTestId("automation-chip-schedule").click();
      const menu = window.getByTestId("automation-menu-schedule");
      await expect(menu).toBeVisible({ timeout: 5_000 });
      await expect(window.getByTestId("automation-schedule-weekdays")).toBeVisible();
      await window.waitForTimeout(300);
      await shot(window, testInfo, `automation-schedule-menu-${theme}-desk`);
      await window.keyboard.press("Escape");
      await expect(menu).not.toBeVisible({ timeout: 5_000 });

      // A project-missing automation's page, when there is one (not a required shot).
      if (orphanId && theme === "dark") {
        await openAutomationsList(window);
        await rowOf(orphanId).click();
        await expect(window.getByTestId("automation-project-missing")).toBeVisible({ timeout: 10_000 });
        await shot(window, testInfo, `automation-project-missing-${theme}-desk`);
      }

      // A new automation (dark only).
      if (theme === "dark") {
        await openAutomationsList(window);
        await window.getByTestId("automation-new").click();
        await expect(window.getByTestId("automation-detail")).toBeVisible({ timeout: 10_000 });
        await expect(window.getByTestId("automation-create")).toBeVisible();
        await shot(window, testInfo, `automation-new-${theme}-desk`);
        await window.getByTestId("automation-cancel").click();
        await expect(window.getByTestId("automations-page")).toBeVisible({ timeout: 10_000 });
      }

      // The bell, holding "Morning PR triage ran".
      await closeSettings(window);
      await window.getByTestId("notifications-bell").click();
      const popover = window.getByTestId("notifications-popover");
      await expect(popover).toBeVisible({ timeout: 5_000 });
      await expect(
        popover.getByTestId("notification-row").filter({ hasText: "Morning PR triage ran" }).first(),
      ).toBeVisible({ timeout: 30_000 });
      await window.waitForTimeout(300);
      await shot(window, testInfo, `bell-automation-${theme}-desk`);
      await window.keyboard.press("Escape");
      await expect(popover).not.toBeVisible({ timeout: 5_000 });
    }
  });
});
