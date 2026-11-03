import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, importSeededProject, test } from "./fixtures";
import { setAgentCommand } from "./helpers/settings";

/**
 * The New Workspace dialog as a composer card: the name is its title, with
 * the branch it makes under it; the agent prompt sits in a box whose foot
 * holds the host, project, folder and branch chips. The branch chip chooses
 * between branching off a base and checking out an existing branch.
 *
 * The prompt also takes images, shown as thumbnails and sent as paths.
 *
 * Screenshots land in `MANOR_SHOTS` when it is set.
 */

const SHOTS = process.env.MANOR_SHOTS;
const LIGHT_THEME = "E2E Latte";
const DARK_THEME = "__default__";
const PHONE = { width: 400, height: 844 };

type Theme = "dark" | "light";

/**
 * Catppuccin Latte's palette as a Ghostty theme file, where the theme manager
 * looks: Manor's custom themes, and Ghostty's own folders, which an installed
 * Ghostty.app shadows.
 */
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
    path.join(tempHome, ".manor", "themes"),
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
    // Selected as a custom theme, the copy in ~/.manor/themes.
    theme === "light" ? `custom:${LIGHT_THEME}` : DARK_THEME,
  );
  if (theme === "light") {
    await expect.poll(bg, { timeout: 10_000 }).toBe("#eff1f5");
  } else if (before === "#eff1f5") {
    await expect.poll(bg, { timeout: 10_000 }).not.toBe("#eff1f5");
  }
  await window.waitForTimeout(300);
}

async function shot(window: Page, name: string, target = dialog(window)): Promise<void> {
  if (!SHOTS) return;
  await window.waitForTimeout(250);
  await target.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

const dialog = (window: Page) => window.getByTestId("new-workspace-dialog");
const nameInput = (window: Page) => window.getByTestId("new-workspace-name-input");
const branchChip = (window: Page) => window.getByTestId("new-workspace-base-branch-select");

async function openDialog(window: Page): Promise<void> {
  await window.keyboard.press("ControlOrMeta+Shift+n");
  await expect(dialog(window)).toBeVisible({ timeout: 5_000 });
  await expect(nameInput(window)).toBeFocused();
}

/** The dialog with the open chip list beside it, for a screenshot of both. */
async function shotWithList(window: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await window.waitForTimeout(250);
  const box = await dialog(window).boundingBox();
  const list = await window.getByRole("listbox").boundingBox();
  if (!box || !list) return;
  const x = Math.min(box.x, list.x) - 8;
  const y = Math.min(box.y, list.y) - 8;
  await window.screenshot({
    path: path.join(SHOTS, `${name}.png`),
    clip: {
      x,
      y,
      width: Math.max(box.x + box.width, list.x + list.width) - x + 8,
      height: Math.max(box.y + box.height, list.y + list.height) - y + 8,
    },
  });
}

function seedBranches(tempHome: string): void {
  const repo = path.join(tempHome, "test-project");
  for (const branch of ["feat/automations", "fix/tab-drag-visuals"]) {
    execFileSync("git", ["-C", repo, "branch", branch]);
  }
}

async function addPodProfile(window: Page): Promise<void> {
  await window.evaluate(() =>
    window.electronAPI.hostProfiles.save({ name: "Work cluster", templateId: "docker", values: {} }),
  );
}

test("the dialog is a composer card: title name, branch line, prompt box with chips", async ({
  app,
  window,
  tempHome,
}) => {
  installLightTheme(tempHome);
  seedBranches(tempHome);
  await importSeededProject(app, window, tempHome);

  for (const theme of ["dark", "light"] as const) {
    await selectTheme(window, theme);
    await openDialog(window);
    await nameInput(window).fill("Fix login redirect");
    await expect(window.getByTestId("new-workspace-branch-input")).toHaveValue("Fix-login-redirect");
    await expect(window.getByTestId("new-workspace-agent-prompt")).toBeVisible();
    await expect(branchChip(window)).toHaveText(/off\s*main/);
    await shot(window, `composer-${theme}`);

    // The branch chip lists both ways to get a branch.
    await branchChip(window).click();
    const list = window.getByRole("listbox");
    await expect(list).toContainText("New branch off");
    await expect(list).toContainText("Check out existing");
    await expect(list.getByRole("option", { name: "feat/automations" })).toBeVisible();
    await shotWithList(window, `branch-list-${theme}`);
    await window.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(dialog(window)).toBeVisible();

    await window.keyboard.press("Escape");
    await expect(dialog(window)).toBeHidden();
  }
});

test("picking an existing branch fills the name and checks the branch out", async ({
  app,
  window,
  tempHome,
}) => {
  seedBranches(tempHome);
  await importSeededProject(app, window, tempHome);
  await openDialog(window);

  await branchChip(window).click();
  await window.getByRole("listbox").getByRole("option", { name: "feat/automations" }).click();
  await expect(nameInput(window)).toHaveValue("feat/automations");
  await expect(window.getByTestId("new-workspace-checks-out")).toHaveText("Checks out feat/automations");
  await expect(window.getByTestId("new-workspace-branch-input")).toHaveCount(0);
  await expect(branchChip(window)).toHaveText(/feat\/automations/);
  await shot(window, "existing-branch");

  // A base branch goes back to making a new branch, named from the title.
  await branchChip(window).click();
  await window.getByRole("listbox").getByRole("option", { name: "main" }).first().click();
  await expect(window.getByTestId("new-workspace-branch-input")).toHaveValue("feat/automations");
  await expect(branchChip(window)).toHaveText(/off\s*main/);

  // Back to the existing branch, and create: the workspace is on it.
  await branchChip(window).click();
  await window.getByRole("listbox").getByRole("option", { name: "feat/automations" }).click();
  await nameInput(window).fill("Automations");
  await window.getByTestId("new-workspace-submit").click();
  await expect(dialog(window)).toBeHidden({ timeout: 15_000 });
  await expect
    .poll(() =>
      execFileSync("git", ["-C", path.join(tempHome, "test-project"), "worktree", "list"], {
        encoding: "utf-8",
      }),
    )
    .toContain("[feat/automations]");
});

test("the host chip lists the host and the set-up rows", async ({ app, window, tempHome }) => {
  installLightTheme(tempHome);
  await addPodProfile(window);
  await importSeededProject(app, window, tempHome);

  for (const theme of ["dark", "light"] as const) {
    await selectTheme(window, theme);
    await openDialog(window);
    await nameInput(window).fill("Try a pod");
    const host = window.getByTestId("new-workspace-host-picker");
    await expect(host).toBeVisible();
    await host.click();
    const list = window.getByRole("listbox");
    await expect(list.getByRole("option").first()).toBeVisible();
    await expect(window.getByTestId("new-workspace-set-up-in-new-pod")).toContainText("Work cluster");
    await shotWithList(window, `host-list-${theme}`);
    await window.keyboard.press("Escape");
    await window.keyboard.press("Escape");
    await expect(dialog(window)).toBeHidden();
  }
});

test("a prompt with text starts an agent; an empty one starts none", async ({
  app,
  window,
  tempHome,
}) => {
  await importSeededProject(app, window, tempHome);
  // Panes of the workspace on screen; other workspaces' stay mounted, hidden.
  const visiblePanes = () => window.locator('[data-testid="terminal-pane"]:visible').count();

  await openDialog(window);
  await nameInput(window).fill("No agent");
  await window.getByTestId("new-workspace-submit").click();
  await expect(dialog(window)).toBeHidden({ timeout: 15_000 });
  await window.waitForTimeout(2_000);
  expect(await visiblePanes()).toBe(0);

  await openDialog(window);
  await nameInput(window).fill("With agent");
  await window.getByTestId("new-workspace-agent-prompt").fill("Say hello");
  await window.getByTestId("new-workspace-agent-prompt").press("ControlOrMeta+Enter");
  await expect(dialog(window)).toBeHidden({ timeout: 15_000 });
  await expect.poll(visiblePanes, { timeout: 15_000 }).toBe(1);
});

/** A PNG drawn in the page: a diagonal gradient from `from` to `to`, with a dot. */
async function drawPng(window: Page, from: string, to: string): Promise<string> {
  return window.evaluate(
    ([a, b]) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 120;
      const ctx = canvas.getContext("2d")!;
      const g = ctx.createLinearGradient(0, 0, 120, 120);
      g.addColorStop(0, a);
      g.addColorStop(1, b);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 120, 120);
      ctx.fillStyle = "#ffffffcc";
      ctx.beginPath();
      ctx.arc(40, 44, 16, 0, Math.PI * 2);
      ctx.fill();
      return canvas.toDataURL("image/png").split(",")[1];
    },
    [from, to],
  );
}

/** Fires `type` at `selector` carrying the PNG as a file, as a paste or a drop does. */
async function sendImage(
  window: Page,
  selector: string,
  type: "paste" | "drop",
  base64: string,
  name: string,
): Promise<void> {
  await window.evaluate(
    ({ selector, type, base64, name }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], name, { type: "image/png" }));
      const target = document.querySelector(selector)!;
      if (type === "paste") {
        target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      } else {
        target.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
        target.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
      }
    },
    { selector, type, base64, name },
  );
}

test("images pasted, picked or dropped show as thumbnails and start the agent as paths after the text", async ({
  app,
  window,
  tempHome,
}) => {
  installLightTheme(tempHome);
  await importSeededProject(app, window, tempHome);
  // An agent that records the prompt it was started with, a line per launch
  // (a launch with no prompt adds an empty one).
  const promptLog = path.join(tempHome, "agent-prompt.txt");
  const agent = path.join(tempHome, "record-prompt.sh");
  fs.writeFileSync(agent, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${promptLog}'\nexec sleep 300\n`, { mode: 0o755 });
  await setAgentCommand(window, "test-project", `"${agent}"`);

  const prompt = window.getByTestId("new-workspace-agent-prompt");
  const thumbs = dialog(window).getByTestId("image-attachment");
  const pink = await drawPng(window, "#f5c2e7", "#74c7ec");
  const sand = await drawPng(window, "#f9e2af", "#fab387");
  const leaf = await drawPng(window, "#a6e3a1", "#89b4fa");

  await openDialog(window);
  await nameInput(window).fill("Fix login redirect");
  await prompt.fill("The redirect lands on a blank page, see these");

  await sendImage(window, '[data-testid="new-workspace-agent-prompt"]', "paste", pink, "pasted.png");
  await expect(thumbs).toHaveCount(1);
  await dialog(window).getByTestId("chat-attach-input").setInputFiles({
    name: "picked.png",
    mimeType: "image/png",
    buffer: Buffer.from(sand, "base64"),
  });
  await expect(thumbs).toHaveCount(2);
  await sendImage(window, '[data-testid="new-workspace-dialog"] [data-testid="image-attachments"]', "drop", leaf, "dropped.png");
  await expect(thumbs).toHaveCount(3);
  // The text holds no paths.
  await expect(prompt).toHaveValue("The redirect lands on a blank page, see these");
  await expect(dialog(window).locator("[data-uploading]")).toHaveCount(0, { timeout: 10_000 });

  for (const theme of ["dark", "light"] as const) {
    await selectTheme(window, theme);
    await shot(window, `images-${theme}`);
  }

  // × drops the picked image, and its path is not sent.
  await thumbs.nth(1).getByTestId("image-attachment-remove").click();
  await expect(thumbs).toHaveCount(2);
  await shot(window, "images-removed-light");

  await window.getByTestId("new-workspace-submit").click();
  await expect(dialog(window)).toBeHidden({ timeout: 15_000 });
  const readPrompt = () => (fs.existsSync(promptLog) ? fs.readFileSync(promptLog, "utf8") : "");
  const expected = /^The redirect lands on a blank page, see these (\S+\.png) (\S+\.png)$/m;
  await expect.poll(readPrompt, { timeout: 20_000 }).toMatch(expected);
  const match = readPrompt().match(expected);
  // The paste first, then the drop: each is a file on the host the agent runs on.
  expect(fs.readFileSync(match![1])).toEqual(Buffer.from(pink, "base64"));
  expect(fs.readFileSync(match![2])).toEqual(Buffer.from(leaf, "base64"));

  // Opened again, the dialog starts with no images; images alone start an agent.
  fs.rmSync(promptLog);
  await openDialog(window);
  await expect(thumbs).toHaveCount(0);
  await nameInput(window).fill("Images only");
  await sendImage(window, '[data-testid="new-workspace-agent-prompt"]', "paste", sand, "only.png");
  await expect(dialog(window).locator("[data-uploading]")).toHaveCount(0, { timeout: 10_000 });
  await window.getByTestId("new-workspace-agent-prompt").press("ControlOrMeta+Enter");
  await expect(dialog(window)).toBeHidden({ timeout: 15_000 });
  await expect.poll(readPrompt, { timeout: 20_000 }).toMatch(/^\S+\.png$/m);
});

test("the folder chip makes a folder from its search and picks it", async ({
  app,
  window,
  tempHome,
}) => {
  await importSeededProject(app, window, tempHome);
  await openDialog(window);
  const folder = window.getByTestId("new-workspace-folder-select");
  await folder.click();
  await window.keyboard.type("Backend");
  await window.getByTestId("new-workspace-folder-select-create").click();
  await expect(folder).toHaveText(/Backend/);
});

test("long folder and branch names keep the chips on one row, and the folder list stays narrow", async ({
  app,
  window,
  tempHome,
}) => {
  const longBranch = "fix/confirm-dialog-keeps-focus-on-the-cancel-button-after-escape";
  execFileSync("git", ["-C", path.join(tempHome, "test-project"), "branch", longBranch]);
  await importSeededProject(app, window, tempHome);
  await openDialog(window);

  // The folder search caps the name, and the list doesn't stretch to fit it.
  const folder = window.getByTestId("new-workspace-folder-select");
  await folder.click();
  const longName = "This is a super long folder name ".repeat(4);
  await window.keyboard.type(longName);
  const search = window.getByPlaceholder("Search or create...");
  await expect(search).toHaveValue(longName.slice(0, 60));
  const list = await window.getByRole("listbox").boundingBox();
  expect(list!.width).toBeLessThanOrEqual(360);
  await shotWithList(window, "long-folder-list");
  await window.getByTestId("new-workspace-folder-select-create").click();

  await branchChip(window).click();
  await window.keyboard.type("confirm-dialog");
  await window.getByRole("option", { name: longBranch }).last().click();

  // Every chip sits on the same row (the attach button's file input is never drawn).
  const chips = window.getByTestId("new-workspace-chips").locator(":scope > *");
  const tops = await chips.evaluateAll((els) =>
    els.filter((el) => el.getClientRects().length > 0).map((el) => el.getBoundingClientRect().top),
  );
  expect(tops.length).toBeGreaterThanOrEqual(2);
  expect(new Set(tops).size).toBe(1);
  await shot(window, "long-names-one-row");
});

test("Set up on another host… opens the set-up dialog from the host chip", async ({
  app,
  window,
  tempHome,
}) => {
  installLightTheme(tempHome);
  await importSeededProject(app, window, tempHome);
  // A host the project isn't on yet; it never connects, which is fine here.
  await window.evaluate(() => window.electronAPI.hosts.add("e2e@unreachable.invalid"));

  for (const theme of ["dark", "light"] as const) {
    await selectTheme(window, theme);
    await openDialog(window);
    const host = window.getByTestId("new-workspace-host-picker");
    await expect(host).toBeVisible({ timeout: 10_000 });
    await host.click();
    await expect(window.getByTestId("new-workspace-set-up-on-host")).toBeVisible();
    await shotWithList(window, `host-set-up-${theme}`);
    await window.getByTestId("new-workspace-set-up-on-host").click();
    const setUp = window.getByRole("dialog").filter({ hasText: /another host|Set up/i }).last();
    await expect(setUp).toBeVisible();
    await shot(window, `clone-dialog-${theme}`, window.locator("body"));
    await window.keyboard.press("Escape");
    // Focus comes back to the host chip.
    await expect(host).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(dialog(window)).toBeHidden();
  }
});

test("the card fits at phone width", async ({ app, window, tempHome }) => {
  installLightTheme(tempHome);
  await importSeededProject(app, window, tempHome);
  await app.evaluate(({ BrowserWindow }, s) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win?.isMaximized()) win.unmaximize();
    win?.setSize(s.width, s.height);
  }, PHONE);
  await expect
    .poll(() => window.evaluate(() => document.documentElement.dataset.layout), { timeout: 10_000 })
    .toBe("phone");

  for (const theme of ["dark", "light"] as const) {
    await selectTheme(window, theme);
    await window.keyboard.press("ControlOrMeta+Shift+n");
    await expect(dialog(window)).toBeVisible({ timeout: 5_000 });
    await nameInput(window).fill("Fix login redirect");
    // With images attached, the strip above the prompt fits too.
    const files = [];
    for (const [i, [from, to]] of [["#f5c2e7", "#74c7ec"], ["#f9e2af", "#fab387"], ["#a6e3a1", "#89b4fa"]].entries()) {
      files.push({ name: `phone-${i}.png`, mimeType: "image/png", buffer: Buffer.from(await drawPng(window, from, to), "base64") });
    }
    await dialog(window).getByTestId("chat-attach-input").setInputFiles(files);
    await expect(dialog(window).getByTestId("image-attachment")).toHaveCount(3);
    await expect(dialog(window).locator("[data-uploading]")).toHaveCount(0, { timeout: 10_000 });
    const box = await dialog(window).boundingBox();
    const width = await window.evaluate(() => window.innerWidth);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    const overflows = await dialog(window).evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(overflows).toBe(false);
    await shot(window, `phone-${theme}`, window.locator("body"));
    await window.keyboard.press("Escape");
    await expect(dialog(window)).toBeHidden();
  }
});
