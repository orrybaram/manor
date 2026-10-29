import fs from "fs";
import path from "path";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";
import { pane } from "./helpers/file-pane";

/**
 * Go to File (⌘P): the active workspace's files, fuzzy-matched; the pick opens
 * in a new file tab from a terminal, and in the focused file pane from one.
 */

test("Go to File opens a fuzzy-matched file, reusing the focused file pane", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-goto");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);

  await runInTerminal(window, "pwd > \"$HOME/ws-path\"");
  await expect.poll(() => fs.existsSync(path.join(tempHome, "ws-path"))).toBe(true);
  const ws = fs.readFileSync(path.join(tempHome, "ws-path"), "utf8").trim();
  fs.mkdirSync(path.join(ws, "src", "components"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "components", "Widget.tsx"), "export const widget = 1;\n");
  fs.writeFileSync(path.join(ws, "src", "components", "WidgetList.tsx"), "export const list = 2;\n");
  fs.writeFileSync(path.join(ws, "src", "index.ts"), "export const index = 3;\n");
  fs.writeFileSync(path.join(ws, "README.md"), "# readme\n");

  const dialog = window.locator('[data-testid="go-to-file"]');
  const editor = () => pane(window).locator('[data-testid="file-pane-editor"]');

  // From the terminal: ⌘P, a fuzzy query, Enter — a new tab's file pane.
  await window.keyboard.press("ControlOrMeta+p");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[cmdk-item]").first()).toBeVisible();
  await window.keyboard.type("wdgt");
  const first = dialog.locator("[cmdk-item]").first();
  await expect(first).toContainText("Widget.tsx");
  await expect(dialog.locator("[cmdk-item]")).toHaveCount(2);
  await window.screenshot({ path: testInfo.outputPath("go-to-file.png") });
  await window.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(editor()).toContainText("export const widget = 1;");
  await window.screenshot({ path: testInfo.outputPath("opened.png") });

  // From that file pane: the pick replaces its file, no new pane.
  await editor().locator(".cm-content").click();
  await window.keyboard.press("ControlOrMeta+p");
  await expect(dialog).toBeVisible();
  await window.keyboard.type("index");
  await expect(dialog.locator("[cmdk-item]").first()).toContainText("index.ts");
  await window.keyboard.press("Enter");
  await expect(editor()).toContainText("export const index = 3;");
  await expect(window.locator('[data-testid="file-pane"]')).toHaveCount(1);

  // Escape closes it without opening anything.
  await window.keyboard.press("ControlOrMeta+p");
  await expect(dialog).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(editor()).toContainText("export const index = 3;");
});
