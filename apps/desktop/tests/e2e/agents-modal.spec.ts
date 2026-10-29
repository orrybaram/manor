import fs from "fs";
import path from "path";
import type { ElectronApplication, Page } from "@playwright/test";
import { killApp, launchApp, test as base, expect } from "./fixtures";
import { FAKE_AGENT } from "./helpers/fake-agent";
import { waitForVisibleSession } from "./helpers/local-api";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";

/**
 * The Agents modal: it opens in its search box, searches every agent ever
 * recorded (not just the loaded page), moves a highlight with the arrow keys,
 * resumes with Enter, and its Open tab means "pane open in a workspace now".
 *
 * Seeded before launch: three projects (two colored, one not) and 120 old
 * agents, one of them older than the first page the modal loads. One seeded
 * agent is persisted `active` with a pane that no longer exists and last said
 * `responded`, which the boot sweep leaves alone: the stale record that used
 * to fill the old "Active" tab.
 */

const LIVE_TITLE = "live-agent";
const ANCIENT = "Ancient needle migration";
const STALE = "Stale responded agent";
const OUT = path.join(__dirname, "artifacts", "agents-modal");

const DAY = 24 * 60 * 60 * 1000;

function seedDirs(tempHome: string): string[] {
  return [
    path.join(tempHome, "Library", "Application Support", "Manor"),
    path.join(tempHome, ".local", "share", "Manor"),
  ];
}

function project(id: string, name: string, projectPath: string, color: string | null) {
  return {
    id,
    name,
    path: projectPath,
    defaultBranch: "main",
    workspaces: [{ path: projectPath, branch: "main", isMain: true, name: null, linkedIssues: [] }],
    workspaceFolders: [],
    selectedWorkspaceIndex: 0,
    defaultRunCommand: null,
    worktreePath: null,
    worktreeStartScript: null,
    worktreeTeardownScript: null,
    linearAssociations: [],
    color,
    agentCommand: null,
    commands: [],
    themeName: null,
    setupComplete: true,
  };
}

const RECENT = [
  ["Fix toast stacking on phone", "manor", 0.02],
  ["Relay: reconnect backoff jitter", "relay", 0.05],
  ["Bump nvim plugins", "dotfiles", 0.08],
  ["Phone chat window memo", "manor", 1.1],
  ["Rate-limit pairing codes", "relay", 1.2],
  ["Zsh prompt timing", "dotfiles", 1.3],
] as const;

function seedAgents(tempHome: string, paths: Record<string, string>) {
  const now = Date.now();
  const agents: Record<string, unknown>[] = [];
  const add = (name: string, projectName: string, ageDays: number, extra: Record<string, unknown> = {}) => {
    const at = new Date(now - ageDays * DAY).toISOString();
    const i = agents.length;
    agents.push({
      id: `seed-${i}`,
      agentSessionId: `seed-session-${i}`,
      name,
      namePinned: true,
      status: "completed",
      createdAt: at,
      updatedAt: at,
      completedAt: at,
      activatedAt: at,
      projectId: `proj-${projectName}`,
      projectName,
      hostId: "local",
      workspacePath: paths[projectName],
      cwd: paths[projectName],
      agentKind: "claude",
      agentCommand: "claude",
      paneId: null,
      lastAgentStatus: "complete",
      resumedAt: null,
      transcriptPath: null,
      ...extra,
    });
  };
  for (const [name, proj, age] of RECENT) add(name, proj, age);
  add(STALE, "relay", 0.5, { status: "active", paneId: "pane-long-gone", lastAgentStatus: "responded", completedAt: null });
  const names = ["manor", "relay", "dotfiles"];
  for (let i = 0; i < 115; i++) add(`Old task ${i}`, names[i % 3], 3 + i * 0.3);
  add(ANCIENT, "manor", 60);
  return { agents };
}

const test = base.extend<{ app: ElectronApplication }>({
  app: async ({ tempHome }, use) => {
    const paths: Record<string, string> = { manor: path.join(tempHome, "test-project") };
    for (const name of ["relay", "dotfiles"]) {
      paths[name] = path.join(tempHome, name);
      fs.mkdirSync(paths[name], { recursive: true });
    }
    const projects = {
      projects: [
        project("proj-manor", "manor", paths.manor, "blue"),
        project("proj-relay", "relay", paths.relay, "magenta"),
        project("proj-dotfiles", "dotfiles", paths.dotfiles, null),
      ],
      selectedProjectIndex: 0,
    };
    for (const dir of seedDirs(tempHome)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "projects.json"), JSON.stringify(projects, null, 2));
      fs.writeFileSync(path.join(dir, "agents.json"), JSON.stringify(seedAgents(tempHome, paths), null, 2));
    }
    const app = await launchApp(tempHome);
    await use(app);
    await killApp(app);
  },
});

const modal = (w: Page) => w.getByTestId("agents-modal");
const search = (w: Page) => w.getByTestId("agents-modal-search");
const rows = (w: Page) => w.getByTestId("agents-modal-row");
const rowNamed = (w: Page, name: string) => rows(w).filter({ has: w.getByTestId("agent-name").getByText(name, { exact: true }) });

async function openModal(w: Page) {
  await w.getByTestId("sidebar-agents-view-all").click();
  await expect(modal(w)).toBeVisible({ timeout: 10_000 });
}

async function shot(w: Page, name: string) {
  await w.waitForTimeout(250);
  await modal(w).screenshot({ path: path.join(OUT, `${name}.png`), animations: "disabled" });
}

/**
 * Catppuccin Latte, the light half of the default palette. Selected by name;
 * a throwaway profile may not have the theme list loaded, so its colours are
 * applied directly if selecting it changed nothing.
 */
async function useLightTheme(w: Page) {
  await w.evaluate(() => window.electronAPI.theme.setSelected("Catppuccin Latte")).catch(() => {});
  await w.waitForTimeout(800);
  const scheme = await w.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  if (scheme === "light") return;
  await w.evaluate(() => {
    const latte: Record<string, string> = {
      "--bg": "#eff1f5",
      "--fg": "#4c4f69",
      "--dim": "#e6e9ef",
      "--surface": "#ccd0da",
      "--hover": "#dce0e8",
      "--border": "#bcc0cc",
      "--text-primary": "#4c4f69b3",
      "--text-selected": "#4c4f69",
      "--text-dim": "#4c4f6980",
      "--accent": "#1e66f5",
      "--blue": "#1e66f5",
      "--green": "#40a02b",
      "--red": "#d20f39",
      "--yellow": "#df8e1d",
      "--magenta": "#ea76cb",
      "--cyan": "#179299",
    };
    for (const [k, v] of Object.entries(latte)) document.documentElement.style.setProperty(k, v);
    document.documentElement.style.colorScheme = "light";
  });
}

test("Agents modal: search, arrow keys, Open/Closed, project colors", async ({ window, tempHome, request }) => {
  test.setTimeout(180_000);
  fs.mkdirSync(OUT, { recursive: true });

  // A live agent in a pane of the manor project. The app opens on Home,
  // which has no tabs: go to manor's main workspace first.
  await window.getByTestId("workspace-item").first().click({ timeout: 30_000 });
  await window.keyboard.press("ControlOrMeta+t");
  await expect(window.locator('[data-testid="terminal-pane"]:visible').first()).toBeVisible({ timeout: 30_000 });
  const paneId = await activePaneId(window);
  await awaitShellReady(window, tempHome, paneId);
  await runInTerminal(window, `"${FAKE_AGENT}" ${LIVE_TITLE}`);
  await waitForVisibleSession(request, tempHome, { name: LIVE_TITLE });

  await openModal(window);
  await expect(search(window)).toBeFocused();
  await expect(rowNamed(window, "Fix toast stacking on phone")).toBeVisible({ timeout: 10_000 });
  await expect(rowNamed(window, ANCIENT)).toHaveCount(0);

  // Colored projects color their rows' project dot; the uncolored one gets a hollow ring.
  const colored = (name: string) => rowNamed(window, name).evaluate((el) => el.hasAttribute("data-colored"));
  expect(await colored("Fix toast stacking on phone")).toBe(true);
  expect(await colored("Relay: reconnect backoff jitter")).toBe(true);
  expect(await colored("Bump nvim plugins")).toBe(false);
  await expect(window.getByTestId("agents-modal-tab-all")).toHaveText("All");
  await expect(window.getByTestId("agents-modal-tab-open")).toHaveText("Open");
  await expect(window.getByTestId("agents-modal-tab-closed")).toHaveText("Closed");
  await shot(window, "dark-list");

  // Arrow keys move the highlight from the search box.
  const highlightedName = () => window.locator('[data-testid="agents-modal-row"][data-highlighted]').getByTestId("agent-name").textContent();
  const first = await highlightedName();
  await window.keyboard.press("ArrowDown");
  await window.keyboard.press("ArrowDown");
  const third = await rows(window).nth(2).getByTestId("agent-name").textContent();
  expect(await highlightedName()).toBe(third);
  await window.keyboard.press("ArrowUp");
  await window.keyboard.press("ArrowUp");
  expect(await highlightedName()).toBe(first);
  await window.keyboard.press("ArrowDown");
  await expect(search(window)).toBeFocused();
  await shot(window, "dark-highlight");

  // Open: only the agent whose pane is open; the stale "active" record is Closed.
  await window.getByTestId("agents-modal-tab-open").click();
  await expect(rows(window)).toHaveCount(1);
  await expect(rowNamed(window, LIVE_TITLE)).toBeVisible();
  await shot(window, "dark-open");
  await window.getByTestId("agents-modal-tab-closed").click();
  await expect(rowNamed(window, STALE)).toBeVisible();
  await expect(rowNamed(window, LIVE_TITLE)).toHaveCount(0);
  await window.getByTestId("agents-modal-tab-all").click();

  // Search reaches an agent older than the first loaded page. (The short
  // Open tab above may have paged it in since; it was not there at first.)
  await search(window).fill("ancient needle");
  await expect(rowNamed(window, ANCIENT)).toBeVisible({ timeout: 10_000 });
  await expect(rows(window)).toHaveCount(1);
  await shot(window, "dark-search");

  await search(window).fill("zzz no such agent");
  await expect(window.getByTestId("agents-modal-empty")).toHaveText("No sessions match “zzz no such agent”");
  await shot(window, "dark-empty");

  // F2 renames the highlighted search match; focus comes back to the search
  // box, and ⌘/Ctrl+Backspace removes the match from the results too.
  await search(window).fill("zsh prompt");
  await expect(rows(window)).toHaveCount(1, { timeout: 10_000 });
  await window.keyboard.press("F2");
  const renameInput = window.getByTestId("agent-name-input");
  await expect(renameInput).toBeFocused();
  await renameInput.fill("Zsh prompt timing, renamed");
  await renameInput.press("Enter");
  await expect(rowNamed(window, "Zsh prompt timing, renamed")).toBeVisible();
  await expect(search(window)).toBeFocused();
  await window.keyboard.press("ControlOrMeta+Backspace");
  await expect(window.getByTestId("agents-modal-empty")).toBeVisible();

  // Enter resumes the highlighted agent and closes the modal.
  await search(window).fill(LIVE_TITLE);
  await expect(rows(window)).toHaveCount(1);
  await window.keyboard.press("Enter");
  await expect(modal(window)).toBeHidden({ timeout: 5_000 });
  await expect(window.locator('[data-testid="workspace-pane"]:visible')).toHaveCount(1);

  // Reopening starts from an empty search, in the light theme too.
  await useLightTheme(window);
  await openModal(window);
  await expect(search(window)).toBeFocused();
  await expect(search(window)).toHaveValue("");
  await expect(rowNamed(window, "Fix toast stacking on phone")).toBeVisible();
  await window.keyboard.press("ArrowDown");
  await shot(window, "light-list");
  await window.getByTestId("agents-modal-tab-open").click();
  await shot(window, "light-open");
  await window.getByTestId("agents-modal-tab-all").click();
  await search(window).fill("ancient");
  await expect(rowNamed(window, ANCIENT)).toBeVisible({ timeout: 10_000 });
  await shot(window, "light-search");
  await search(window).fill("zzz no such agent");
  await shot(window, "light-empty");
});
