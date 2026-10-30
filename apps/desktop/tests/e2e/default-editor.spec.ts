import fs from "fs";
import path from "path";
import type { TestInfo } from "@playwright/test";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";
import {
  activePaneId,
  awaitShellReady,
  modifierClickText,
  paneText,
  rightClickText,
  runInTerminal,
} from "./helpers/terminal";
import { pane } from "./helpers/file-pane";
import { closeSettings, openSettings } from "./helpers/settings";

/**
 * Settings → General → Default editor: Manor, the default, opens a
 * Cmd/Ctrl-clicked workspace file in a file pane; another app gets it
 * instead, by its command.
 */

function shot(testInfo: TestInfo, name: string): string {
  return testInfo.outputPath(`${name}.png`);
}

test("Cmd/Ctrl-clicking a workspace file opens it in Manor, or in the editor chosen instead", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-default-editor");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);

  await runInTerminal(window, "pwd > \"$HOME/ws-path\"");
  await expect.poll(() => fs.existsSync(path.join(tempHome, "ws-path"))).toBe(true);
  const ws = fs.readFileSync(path.join(tempHome, "ws-path"), "utf8").trim();
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "notes.md"), "# Notes\n");

  // Manor is the default.
  await openSettings(window);
  await window.getByTestId("settings-nav-general").click();
  const kind = window.getByTestId("default-editor-kind");
  await expect(kind.getByRole("radio", { name: "Manor" })).toHaveAttribute("aria-checked", "true");
  await expect(window.getByTestId("default-editor-command")).toHaveCount(0);
  await window.screenshot({ path: shot(testInfo, "settings-manor") });
  await closeSettings(window);

  const printed = "src/notes.md";
  await runInTerminal(window, `echo ${printed}`);
  await expect.poll(() => paneText(window, termId)).toMatch(/^src\/notes\.md/m);

  // The first hover lists the workspace; until that answers there is no link.
  const openItem = window.locator('[data-testid="terminal-link-open-file-pane"]');
  await expect(async () => {
    await rightClickText(window, termId, printed);
    if (!(await openItem.isVisible())) {
      await window.keyboard.press("Escape");
      throw new Error("no file link yet");
    }
  }).toPass({ timeout: 15_000 });
  await window.keyboard.press("Escape");

  await modifierClickText(window, termId, printed);
  await expect(pane(window)).toBeVisible();
  await expect(pane(window).locator('[data-testid="file-pane-breadcrumb"]')).toContainText("notes.md");
  // The keyboard goes with it, out of the terminal.
  await expect(pane(window).locator('[data-testid="file-pane-editor"] .cm-content')).toBeFocused();
  await window.screenshot({ path: shot(testInfo, "opened-in-manor") });

  // Another app: a script that records what it was asked to open.
  const opened = path.join(tempHome, "editor-opened");
  const editor = path.join(tempHome, "fake-editor.sh");
  fs.writeFileSync(editor, `#!/bin/sh\necho "$1" > "${opened}"\n`, { mode: 0o755 });

  await openSettings(window);
  await window.getByTestId("settings-nav-general").click();
  await kind.getByRole("radio", { name: "Other app" }).click();
  await window.getByTestId("default-editor-command").fill(editor);
  await window.screenshot({ path: shot(testInfo, "settings-other-app") });
  await closeSettings(window);

  const panes = window.locator('[data-testid="workspace-pane"]:visible');
  const before = await panes.count();
  await modifierClickText(window, termId, printed);
  await expect.poll(() => fs.existsSync(opened), { timeout: 10_000 }).toBe(true);
  expect(fs.readFileSync(opened, "utf8").trim()).toBe(path.join(ws, "src", "notes.md"));
  await expect(panes).toHaveCount(before);

  // Back to Manor: the command goes, and so does the field.
  await openSettings(window);
  await window.getByTestId("settings-nav-general").click();
  await kind.getByRole("radio", { name: "Manor" }).click();
  await expect(window.getByTestId("default-editor-command")).toHaveCount(0);
  await expect
    .poll(() => window.evaluate(() => window.electronAPI.preferences.getAll().then((p) => p.defaultEditor)))
    .toBe("");

  await closeSettings(window);

  // Open in Editor, with Manor the editor, makes a file tab of its own, and
  // its tree takes the keyboard.
  await window.keyboard.press("ControlOrMeta+k");
  await window.locator("[cmdk-input]").fill("Open in Editor");
  const item = window.locator("[cmdk-item]", { hasText: "Open in Editor" }).first();
  await expect(item).toContainText("Manor");
  await item.click();
  await expect(window.locator('[data-testid="file-pane-tree"]:visible')).toBeFocused();
  await window.screenshot({ path: shot(testInfo, "open-in-manor") });
});
