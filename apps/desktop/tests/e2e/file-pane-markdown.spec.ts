import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import type { Page, TestInfo } from "@playwright/test";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";
import {
  activePaneId,
  awaitShellReady,
  paneText,
  rightClickText,
  runInTerminal,
} from "./helpers/terminal";
import { openFileFromPalette, openFromTree, pane, typeAtEnd } from "./helpers/file-pane";

/**
 * A markdown file in the file pane (#678): a toggle between its source and it
 * rendered, which follows the file, keeps your edits and is remembered.
 */

test.describe.configure({ timeout: 120_000 });

const README = `---
name: demo
status: draft
---

# Project plan

Intro with **bold**, \`code\`, and a [link to the guide](docs/guide.md).

- [x] Write the spec
- [ ] Ship it

| Step | Owner |
| ---- | ----- |
| Build | Ada |

![diagram](assets/diagram.png)

\`\`\`ts
const answer = 42;
\`\`\`

[Jump to the end](#the-end)
[Same file by name](README.md#the-end)
[Jump to the anchor](#install)
<a name="install"></a>

![remote http](http://127.0.0.1:9/pixel.png)

${Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n")}

## The end

<script>window.__mdInjected = true</script>
<img src="x" onerror="window.__mdInjected = true">
Finished.
`;

const preview = (window: Page) => pane(window).locator('[data-testid="file-pane-markdown-preview"]');
const toggle = (window: Page) => pane(window).locator('[data-testid="file-pane-markdown-toggle"]');
const editor = (window: Page) => pane(window).locator('[data-testid="file-pane-editor"]');

const shot = async (window: Page, testInfo: TestInfo, name: string) => {
  await window.screenshot({ path: testInfo.outputPath(`${name}.png`) });
};

async function bootRepo(
  app: Parameters<typeof bootWorkspaceWithTerminal>[0],
  window: Page,
  tempHome: string,
  name: string,
): Promise<string> {
  await bootWorkspaceWithTerminal(app, window, tempHome, name);
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);
  await runInTerminal(window, 'pwd > "$HOME/ws-path"');
  await expect.poll(() => fs.existsSync(path.join(tempHome, "ws-path"))).toBe(true);
  const ws = fs.readFileSync(path.join(tempHome, "ws-path"), "utf8").trim();
  // These tests write and commit here. A shell that started in the app's own
  // folder, as one can under load, must fail the test, not touch the checkout.
  expect(fs.realpathSync(ws).startsWith(`${fs.realpathSync(tempHome)}${path.sep}`)).toBe(true);
  fs.mkdirSync(path.join(ws, "docs"), { recursive: true });
  fs.writeFileSync(path.join(ws, "README.md"), README);
  fs.writeFileSync(path.join(ws, "docs", "guide.md"), "# The guide\n\nSecond file.\n");
  fs.writeFileSync(path.join(ws, "code.ts"), "export const x = 1;\n");
  return ws;
}

test("a markdown file renders, follows the disk, keeps edits, and is remembered", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  const ws = await bootRepo(app, window, tempHome, "ws-md");

  await openFileFromPalette(window);
  await openFromTree(window, ["code.ts"]);
  await expect(editor(window)).toContainText("export const x");
  // Only markdown has anything to render.
  await expect(toggle(window)).toHaveCount(0);

  await openFromTree(window, ["README.md"]);
  await expect(editor(window)).toContainText("# Project plan");
  await expect(toggle(window)).toHaveText("Preview");
  await expect(preview(window)).toHaveCount(0);
  await shot(window, testInfo, "1-source");

  // Rendered: headings, GFM and frontmatter as a block, not as a heading.
  await toggle(window).click();
  await expect(preview(window).locator("h1")).toHaveText("Project plan");
  await expect(toggle(window)).toHaveText("Source");
  await expect(preview(window).locator("strong")).toHaveText("bold");
  await expect(preview(window).locator("table td").first()).toHaveText("Build");
  await expect(preview(window).locator('input[type="checkbox"]')).toHaveCount(2);
  await expect(preview(window).locator("pre").first()).toContainText("name: demo");
  await expect(preview(window).locator("h2")).toHaveText("The end");
  await expect(preview(window)).toContainText("diagram");
  await expect(preview(window)).toBeFocused();
  await expect(editor(window)).toBeHidden();
  await shot(window, testInfo, "2-preview");

  // The sanitiser holds in a file from the repo.
  expect(await window.evaluate(() => (window as { __mdInjected?: boolean }).__mdInjected)).toBeUndefined();

  // An in-page link scrolls to its heading.
  await preview(window).getByRole("button", { name: "Jump to the end" }).click();
  await expect(preview(window).locator("h2")).toBeInViewport();

  // So does one naming this same file, and an HTML anchor is a target too.
  await preview(window).evaluate((el) => el.scrollTo({ top: 0 }));
  await expect(preview(window).locator("h2")).not.toBeInViewport();
  await preview(window).getByRole("button", { name: "Same file by name" }).click();
  await expect(preview(window).locator("h2")).toBeInViewport();
  await expect(preview(window).locator('[id="user-content-install"]')).toHaveCount(1);
  // Nothing goes out in plain text just for opening a file.
  await expect(preview(window).locator('img[src^="http:"]')).toHaveCount(0);
  await expect(preview(window)).toContainText("remote http");
  await preview(window).getByRole("button", { name: "Jump to the end" }).focus();

  // An agent rewrites the file: the preview follows it.
  fs.writeFileSync(path.join(ws, "README.md"), README.replace("Project plan", "Rewritten plan"));
  await expect(preview(window).locator("h1")).toHaveText("Rewritten plan");
  // Without remounting the document, which would drop the keyboard: the link
  // pressed above still has it.
  await expect(preview(window).getByRole("button", { name: "Jump to the end" })).toBeFocused();

  // The key goes back, and types into a visible editor.
  await window.keyboard.press("ControlOrMeta+Shift+V");
  await expect(preview(window)).toHaveCount(0);
  await expect(editor(window)).toBeVisible();
  await expect(editor(window).locator(".cm-content")).toBeFocused();

  // Unsaved edits are what renders, and they survive the round trip.
  await typeAtEnd(window, "\n\nUnsaved words.\n");
  await expect(window.locator('[data-testid="file-pane-dirty"]')).toBeVisible();
  await window.keyboard.press("ControlOrMeta+Shift+V");
  await expect(preview(window)).toContainText("Unsaved words.");
  await shot(window, testInfo, "3-preview-unsaved");
  // ⌘S still saves from the preview, which has the keyboard.
  await window.keyboard.press("ControlOrMeta+s");
  await expect(window.locator('[data-testid="file-pane-dirty"]')).toHaveCount(0);
  await expect
    .poll(() => fs.readFileSync(path.join(ws, "README.md"), "utf8"))
    .toContain("Unsaved words.");
  await expect(preview(window)).toContainText("Unsaved words.");

  // A relative link opens its file here, still rendered: the choice is kept.
  await preview(window).getByRole("button", { name: "link to the guide" }).click();
  await expect(preview(window).locator("h1")).toHaveText("The guide");
  await expect(preview(window)).toBeFocused();
  await shot(window, testInfo, "4-followed-link");

  // Code is untouched by it, and it is back for the next markdown file.
  await openFromTree(window, ["code.ts"]);
  await expect(editor(window)).toContainText("export const x");
  await expect(preview(window)).toHaveCount(0);
  await openFromTree(window, ["README.md"]);
  await expect(preview(window).locator("h1")).toHaveText("Rewritten plan");
  expect(await window.evaluate(() => localStorage.getItem("manor:markdownPreview"))).toBe("1");

  // Find belongs to the source, and opens where it can be seen.
  await preview(window).locator("h1").click();
  await window.keyboard.press("ControlOrMeta+f");
  await expect(preview(window)).toHaveCount(0);
  await expect(
    pane(window).locator('[data-testid="file-pane-find"]').getByRole("textbox", { name: "Find" }),
  ).toBeFocused();
});

test("a diff shows the source, without forgetting the choice", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  const ws = await bootRepo(app, window, tempHome, "ws-md-diff");
  execSync("git add -A && git -c user.name=t -c user.email=t@t commit -qm init", { cwd: ws });
  fs.writeFileSync(path.join(ws, "README.md"), `${README}\nA new line.\n`);

  await openFileFromPalette(window);
  await openFromTree(window, ["README.md"]);
  await toggle(window).click();
  await expect(preview(window).locator("h1")).toHaveText("Project plan");

  // A Source Control row opens the diff, in the editor, and has no toggle.
  await pane(window).locator('[data-testid="file-pane-scm-button"]').click();
  await pane(window).locator('[data-testid="scm-row"]', { hasText: "README.md" }).click();
  await expect(pane(window).locator('[data-testid="file-pane-diff-tag"]')).toBeVisible();
  await expect(preview(window)).toHaveCount(0);
  await expect(toggle(window)).toHaveCount(0);
  await expect(editor(window)).toBeVisible();
  await shot(window, testInfo, "5-diff-shows-source");

  // Open file: back to the plain file, rendered, with the keyboard.
  await pane(window).locator('[data-testid="file-pane-open-plain"]').click();
  await expect(preview(window).locator("h1")).toHaveText("Project plan");
  await expect(preview(window)).toBeFocused();

  // Closing the drawer hands the keyboard to what shows, not the hidden editor.
  await pane(window).locator('[data-testid="file-pane-files-button"]').click();
  await window.keyboard.press("Escape");
  await expect(preview(window)).toBeFocused();
});

test("a terminal link's line shows the source, and Go to File's preview takes the keyboard", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  await bootRepo(app, window, tempHome, "ws-md-line");
  const termId = await activePaneId(window);
  // Rendered is the remembered choice, as if another window had toggled it.
  await window.evaluate(() => {
    localStorage.setItem("manor:markdownPreview", "1");
    window.dispatchEvent(new StorageEvent("storage", { key: "manor:markdownPreview", newValue: "1" }));
  });

  const printed = "README.md:8";
  await runInTerminal(window, `echo ${printed}`);
  await expect.poll(() => paneText(window, termId)).toMatch(/^README\.md:8/m);
  const openItem = window.locator('[data-testid="terminal-link-open-file-pane"]');
  await expect(async () => {
    await rightClickText(window, termId, printed);
    if (!(await openItem.isVisible())) {
      await window.keyboard.press("Escape");
      throw new Error("no file link yet");
    }
  }).toPass({ timeout: 15_000 });
  await openItem.click();

  // The line needs the source to land in; the choice is only set aside.
  await expect(pane(window).locator(".cm-lineNumbers .cm-activeLineGutter")).toHaveText("8");
  await expect(editor(window).locator(".cm-content")).toBeFocused();
  await expect(preview(window)).toHaveCount(0);
  await expect(toggle(window)).toHaveText("Preview");
  await shot(window, testInfo, "6-terminal-line");
  await toggle(window).click();
  await expect(preview(window).locator("h1")).toHaveText("Project plan");

  // Go to File hands over the keyboard, which goes to what shows.
  await window.keyboard.press("ControlOrMeta+p");
  const goToFile = window.locator('[data-testid="go-to-file"]');
  await goToFile.locator("input").fill("guide.md");
  await expect(goToFile.locator("[cmdk-item]").first()).toContainText("guide.md");
  await window.keyboard.press("Enter");
  await expect(goToFile).toBeHidden();
  await expect(preview(window).locator("h1")).toHaveText("The guide");
  await expect(preview(window)).toBeFocused();
});
