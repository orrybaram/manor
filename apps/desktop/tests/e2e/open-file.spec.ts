import fs from "fs";
import os from "os";
import path from "path";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";
import { pane } from "./helpers/file-pane";

/**
 * Opening any file in the file viewer: `manor open-file` from a terminal in
 * the app, and a full path in Go to File, for files outside the workspace.
 */

test("manor open-file and Go to File open a file outside the workspace", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-open-any");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);

  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "manor-open-any-")));
  const notes = path.join(outside, "notes.md");
  fs.writeFileSync(notes, ["# Notes", "two", "three", "four"].join("\n") + "\n");
  // A dotfile: a symlink out of its folder.
  const real = path.join(outside, "dotfiles-zshrc");
  fs.writeFileSync(real, "alias gs='git status'\n");
  const link = path.join(outside, ".zshrc");
  fs.symlinkSync(real, link);

  const editor = () => pane(window).locator('[data-testid="file-pane-editor"]');
  const crumb = () => pane(window).locator('[data-testid="file-pane-breadcrumb"]');

  // The CLI, in the terminal: the tab comes forward, on the asked line.
  await runInTerminal(window, `manor open-file ${notes} --line 3 > "$HOME/open-out" 2>&1`);
  await expect(editor()).toContainText("# Notes", { timeout: 30_000 });
  await expect(crumb()).toHaveAttribute("title", notes);
  await expect(pane(window).locator(".cm-lineNumbers .cm-activeLineGutter")).toHaveText("3");
  await expect(editor().locator(".cm-content")).toBeFocused();
  await window.screenshot({ path: testInfo.outputPath("cli-open.png") });
  expect(fs.readFileSync(path.join(tempHome, "open-out"), "utf8")).toContain(`Opened ${notes}`);

  // It saves, outside the workspace, like any other.
  await editor().locator(".cm-content").click();
  await window.keyboard.press("ControlOrMeta+End");
  await window.keyboard.type("saved from Manor");
  await window.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => fs.readFileSync(notes, "utf8")).toContain("saved from Manor");

  // A change on disk comes back in.
  fs.writeFileSync(notes, "# Rewritten on disk\n");
  await expect(editor()).toContainText("# Rewritten on disk", { timeout: 15_000 });

  // ⌘P: a full path is that file, through a symlink out of its folder.
  await window.keyboard.press("ControlOrMeta+p");
  const dialog = window.locator('[data-testid="go-to-file"]');
  await expect(dialog).toBeVisible();
  await window.keyboard.type(link);
  await expect(dialog.locator('[data-testid="go-to-file-path"]')).toContainText(link);
  await window.screenshot({ path: testInfo.outputPath("go-to-path.png") });
  await window.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(editor()).toContainText("alias gs=");
  await expect(crumb()).toHaveAttribute("title", link);
  await window.screenshot({ path: testInfo.outputPath("go-to-path-opened.png") });

  // The shortcut: `manor <path>`, with no subcommand.
  await window.locator('[role="tab"]').first().click();
  await runInTerminal(window, `manor ${real} > "$HOME/open-short" 2>&1`);
  await expect
    .poll(() => {
      const out = path.join(tempHome, "open-short");
      return fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
    })
    .toContain(`Opened ${real}`);
  await expect(crumb()).toHaveAttribute("title", real, { timeout: 15_000 });

  fs.rmSync(outside, { recursive: true, force: true });
});
