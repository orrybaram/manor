import fs from "fs";
import path from "path";
import type { ElectronApplication, Page } from "@playwright/test";
import { killApp, launchApp, test as base, expect } from "./fixtures";
import { activePaneId, paneText } from "./helpers/terminal";

/**
 * The Agents modal lists Sessions found in the agent CLIs' own stores, not
 * only the Agents Manor launched. Seeded before launch: two projects, a
 * Claude transcript started in a plain terminal, a Codex rollout and a pi
 * session. Each shows in one list with its project, previews its
 * conversation, and the Claude one is marked as outside Manor.
 */

const OUT = path.join(__dirname, "artifacts", "agents-sessions");
const CLAUDE_ID = "7f3c2a10-1111-4a5b-9c8d-000000000001";
const CODEX_ID = "019a0c55-2222-7c3d-8e9f-000000000002";
const PI_ID = "a1b2c3d4-3333-4e5f-8a9b-000000000003";

function project(id: string, name: string, projectPath: string, color: string | null) {
  return {
    id, name, path: projectPath, defaultBranch: "main",
    workspaces: [{ path: projectPath, branch: "main", isMain: true, name: null, linkedIssues: [] }],
    workspaceFolders: [], selectedWorkspaceIndex: 0, defaultRunCommand: null, worktreePath: null,
    worktreeStartScript: null, worktreeTeardownScript: null, linearAssociations: [], color,
    agentCommand: null, commands: [], themeName: null, setupComplete: true,
  };
}

function jsonl(file: string, records: unknown[], mtimeMinutesAgo: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const t = new Date(Date.now() - mtimeMinutesAgo * 60_000);
  fs.utimesSync(file, t, t);
}

function seed(tempHome: string) {
  const manor = path.join(tempHome, "test-project");
  const relay = path.join(tempHome, "relay");
  fs.mkdirSync(relay, { recursive: true });
  const projects = {
    projects: [project("proj-manor", "manor", manor, "blue"), project("proj-relay", "relay", relay, "magenta")],
    selectedProjectIndex: 0,
  };
  for (const dir of [
    path.join(tempHome, "Library", "Application Support", "Manor"),
    path.join(tempHome, ".local", "share", "Manor"),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "projects.json"), JSON.stringify(projects, null, 2));
  }

  const iso = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  // Claude, started in a plain terminal inside the manor project.
  jsonl(path.join(tempHome, ".claude", "projects", manor.replace(/[^a-zA-Z0-9]/g, "-"), `${CLAUDE_ID}.jsonl`), [
    { type: "user", sessionId: CLAUDE_ID, cwd: manor, gitBranch: "main", timestamp: iso(30), uuid: "u1", parentUuid: null,
      message: { role: "user", content: "the toast stack overlaps the bottom bar on the phone layout, fix it" } },
    { type: "assistant", sessionId: CLAUDE_ID, cwd: manor, gitBranch: "main", timestamp: iso(29), uuid: "a1", parentUuid: "u1",
      message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Looking at `ToastDeck` first. The deck is positioned from the viewport bottom and ignores the **bottom bar**." }] } },
    { type: "assistant", sessionId: CLAUDE_ID, cwd: manor, gitBranch: "main", timestamp: iso(28), uuid: "a2", parentUuid: "a1",
      message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test toast" } }] } },
    { type: "assistant", sessionId: CLAUDE_ID, cwd: manor, gitBranch: "main", timestamp: iso(27), uuid: "a3", parentUuid: "a2",
      message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Fixed: the deck now sits above `--status-bar-height`. Tests pass." }] } },
    { type: "ai-title", sessionId: CLAUDE_ID, aiTitle: "Toasts above the phone bottom bar" },
  ], 27);

  // Codex, in the relay project.
  jsonl(path.join(tempHome, ".codex", "sessions", "2026", "10", "27", `rollout-2026-10-27T09-00-00-${CODEX_ID}.jsonl`), [
    { timestamp: iso(180), type: "session_meta", payload: { id: CODEX_ID, timestamp: iso(180), cwd: relay, cli_version: "0.165.0", source: "cli", git: { branch: "feat/backoff" } } },
    { timestamp: iso(179), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "add jitter to the relay reconnect backoff" }] } },
    { timestamp: iso(179), type: "event_msg", payload: { type: "user_message", message: "add jitter to the relay reconnect backoff" } },
    { timestamp: iso(178), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Added full jitter capped at 30s, with a seeded test." }] } },
  ], 178);

  // pi, in a folder that isn't a project.
  const scratch = path.join(tempHome, "scratch");
  fs.mkdirSync(scratch, { recursive: true });
  jsonl(path.join(tempHome, ".pi", "agent", "sessions", `--${scratch.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`, `2026-10-26T10-00-00-000Z_${PI_ID}.jsonl`), [
    { type: "session", version: 3, id: PI_ID, timestamp: iso(1500), cwd: scratch },
    { type: "message", id: "m1", parentId: null, timestamp: iso(1500), message: { role: "user", content: "why does my zsh prompt take 300ms" } },
    { type: "message", id: "m2", parentId: "m1", timestamp: iso(1499), message: { role: "assistant", content: [{ type: "text", text: "It's `git status` in a big repo. Switch to the async segment." }] } },
    { type: "session_info", id: "m3", parentId: "m2", timestamp: iso(1499), name: "Zsh prompt timing" },
  ], 1499);
}

const test = base.extend<{ app: ElectronApplication }>({
  app: async ({ tempHome }, use) => {
    seed(tempHome);
    const app = await launchApp(tempHome);
    await use(app);
    await killApp(app);
  },
});

const modal = (w: Page) => w.getByTestId("agents-modal");
const rows = (w: Page) => w.getByTestId("agents-modal-row");
const rowNamed = (w: Page, name: string) => rows(w).filter({ hasText: name });

async function openModal(w: Page) {
  await w.keyboard.press("ControlOrMeta+k");
  const input = w.locator("[cmdk-input]");
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill("View All Agents");
  await w.locator("[cmdk-item]", { hasText: "View All Agents" }).first().click();
  await expect(modal(w)).toBeVisible({ timeout: 10_000 });
}

async function shot(w: Page, name: string) {
  await w.waitForTimeout(400);
  await modal(w).screenshot({ path: path.join(OUT, `${name}.png`), animations: "disabled" });
}

async function useLightTheme(w: Page) {
  await w.evaluate(() => window.electronAPI.theme.setSelected("Catppuccin Latte")).catch(() => {});
  await w.waitForTimeout(800);
  if ((await w.evaluate(() => getComputedStyle(document.documentElement).colorScheme)) === "light") return;
  await w.evaluate(() => {
    const latte: Record<string, string> = {
      "--bg": "#eff1f5", "--fg": "#4c4f69", "--dim": "#e6e9ef", "--surface": "#ccd0da", "--hover": "#dce0e8",
      "--border": "#bcc0cc", "--text-primary": "#4c4f69b3", "--text-selected": "#4c4f69", "--text-dim": "#4c4f6980",
      "--accent": "#1e66f5", "--blue": "#1e66f5", "--green": "#40a02b", "--red": "#d20f39", "--yellow": "#df8e1d",
      "--magenta": "#ea76cb", "--cyan": "#179299",
    };
    for (const [k, v] of Object.entries(latte)) document.documentElement.style.setProperty(k, v);
    document.documentElement.style.colorScheme = "light";
  });
}

test("Agents modal: Sessions from disk, one list, preview", async ({ window }) => {
  test.setTimeout(120_000);
  fs.mkdirSync(OUT, { recursive: true });

  await window.getByTestId("workspace-item").first().waitFor({ timeout: 30_000 });
  await openModal(window);

  // All three agent kinds' Sessions join the list.
  await expect(rowNamed(window, "Toasts above the phone bottom bar")).toBeVisible({ timeout: 20_000 });
  await expect(rowNamed(window, "add jitter to the relay reconnect backoff")).toBeVisible();
  await expect(rowNamed(window, "Zsh prompt timing")).toBeVisible();

  // Started in a plain terminal: marked as outside Manor.
  await expect(rowNamed(window, "Toasts above the phone bottom bar").getByTestId("agents-modal-outside")).toBeVisible();

  // Project chips: both projects plus the scratch folder.
  const chips = window.getByTestId("agents-modal-chip");
  await expect(chips.filter({ hasText: "manor" })).toBeVisible();
  await expect(chips.filter({ hasText: "relay" })).toBeVisible();
  await expect(chips.filter({ hasText: "scratch" })).toBeVisible();

  // The highlighted Session previews its conversation.
  const preview = window.getByTestId("agents-modal-preview");
  await expect(preview).toContainText("Toasts above the phone bottom bar");
  await expect(window.getByTestId("agents-modal-turns")).toContainText("the toast stack overlaps the bottom bar", { timeout: 10_000 });
  await expect(window.getByTestId("agents-modal-turns")).toContainText("Tests pass.");
  await shot(window, "dark-preview-claude");

  // Arrow down to the Codex session; the preview follows.
  await window.keyboard.press("ArrowDown");
  await expect(window.getByTestId("agents-modal-turns")).toContainText("Added full jitter", { timeout: 10_000 });
  await shot(window, "dark-preview-codex");

  // A project chip narrows the list.
  await chips.filter({ hasText: "relay" }).click();
  await expect(rows(window)).toHaveCount(1);
  await shot(window, "dark-chip-relay");
  await chips.filter({ hasText: "All projects" }).click();

  await window.getByTestId("agents-modal-search").fill("zsh");
  await expect(rows(window)).toHaveCount(1);
  await expect(window.getByTestId("agents-modal-turns")).toContainText("async segment", { timeout: 10_000 });
  await shot(window, "dark-search-pi");

  await window.keyboard.press("Escape");
  await expect(modal(window)).toBeHidden();

  // Light theme; each opening starts from the top row again.
  await useLightTheme(window);
  await openModal(window);
  await expect(window.getByTestId("agents-modal-turns")).toContainText("Tests pass.", { timeout: 10_000 });
  await shot(window, "light-preview-claude");
  await window.keyboard.press("ArrowDown");
  await expect(window.getByTestId("agents-modal-turns")).toContainText("Added full jitter", { timeout: 10_000 });
  await shot(window, "light-preview-codex");
  await window.keyboard.press("ArrowUp");

  // Enter resumes the outside-Manor Claude session in a new pane of the
  // manor workspace, with Claude's own resume command.
  await expect(window.getByTestId("agents-modal-turns")).toContainText("Tests pass.", { timeout: 10_000 });
  await window.keyboard.press("Enter");
  await expect(modal(window)).toBeHidden({ timeout: 5_000 });
  await expect(window.locator('[data-testid="terminal-pane"]:visible').first()).toBeVisible({ timeout: 30_000 });
  const paneId = await activePaneId(window);
  await expect.poll(() => paneText(window, paneId), { timeout: 20_000 }).toContain(`--resume ${CLAUDE_ID}`);
  await window.screenshot({ path: path.join(OUT, "light-resumed-pane.png") });
});

test("Agents modal: phone-width preview and back", async ({ app, window }) => {
  test.setTimeout(120_000);
  fs.mkdirSync(OUT, { recursive: true });
  await window.getByTestId("workspace-item").first().waitFor({ timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(420, 860));
  await window.waitForTimeout(600);
  await openModal(window);
  await expect(rowNamed(window, "Toasts above the phone bottom bar")).toBeVisible({ timeout: 20_000 });
  await window.waitForTimeout(600);
  await window.screenshot({ path: path.join(OUT, "phone-list.png"), animations: "disabled" });
  await rowNamed(window, "Toasts above the phone bottom bar").click();
  await expect(window.getByTestId("agents-modal-turns")).toContainText("Tests pass.", { timeout: 10_000 });
  await expect(window.getByTestId("agents-modal-back")).toBeVisible();
  await window.waitForTimeout(400);
  await window.screenshot({ path: path.join(OUT, "phone-preview.png"), animations: "disabled" });
  await window.getByTestId("agents-modal-back").click();
  await expect(rowNamed(window, "Toasts above the phone bottom bar")).toBeVisible();
  await expect(window.getByTestId("agents-modal-turns")).toHaveCount(0);
});
