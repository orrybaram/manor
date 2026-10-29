import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import type { TestInfo } from "@playwright/test";

import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";
import { header, openFileFromPalette, pane } from "./helpers/file-pane";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";

/**
 * Source Control and its diff at size (#489), standing in for the retired
 * Diff pane's perf specs: ~300 changed files list (and scroll), and a file
 * with a 5,000-line change opens as a diff and still takes typing. The bounds
 * are generous on purpose; this catches a freeze, not a regression of a few
 * milliseconds.
 */

const FILES = 300;
const BIG_LINES = 5_000;

function shot(testInfo: TestInfo, name: string): string {
  return testInfo.outputPath(`${name}.png`);
}

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "e2e",
      GIT_AUTHOR_EMAIL: "e2e@example.com",
      GIT_COMMITTER_NAME: "e2e",
      GIT_COMMITTER_EMAIL: "e2e@example.com",
    },
  });
}

const many = (i: number) => `src/many/file-${String(i).padStart(3, "0")}.ts`;
const manyText = (i: number, value: string) =>
  `// file ${i}\nexport const name = "file-${i}";\nexport const value = "${value}";\n`;
const bigHead = Array.from({ length: 20 }, (_, i) => `export const head${i} = ${i};`).join("\n");
const bigTail = Array.from({ length: 20 }, (_, i) => `export const tail${i} = ${i};`).join("\n");

test("Source Control lists ~300 changes and a 5,000-line diff opens and takes typing", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(240_000);
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-scm-scale");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);
  await runInTerminal(window, "pwd > \"$HOME/ws-path\"");
  await expect.poll(() => fs.existsSync(path.join(tempHome, "ws-path"))).toBe(true);
  const ws = fs.readFileSync(path.join(tempHome, "ws-path"), "utf8").trim();

  // Baseline: 300 small files and a short big.ts, committed.
  fs.mkdirSync(path.join(ws, "src", "many"), { recursive: true });
  for (let i = 0; i < FILES; i++) fs.writeFileSync(path.join(ws, many(i)), manyText(i, "before"));
  const big = path.join(ws, "src", "big.ts");
  fs.writeFileSync(big, `${bigHead}\n${bigTail}\n`);
  git(ws, "add -A");
  git(ws, 'commit -qm "baseline"');

  // Working changes: one line in each small file, 5,000 lines into big.ts.
  for (let i = 0; i < FILES; i++) fs.writeFileSync(path.join(ws, many(i)), manyText(i, "after"));
  const inserted = Array.from(
    { length: BIG_LINES },
    (_, i) => `export const inserted${i} = "line ${i} of the big change";`,
  ).join("\n");
  fs.writeFileSync(big, `${bigHead}\n${inserted}\n${bigTail}\n`);

  await openFileFromPalette(window);
  const strip = pane(window).locator('[data-testid="file-pane-scm-button"]');
  // The strip's count caps at 99+.
  await expect(strip.locator('[data-testid="file-pane-scm-count"]')).toHaveText("99+", {
    timeout: 30_000,
  });
  await strip.click();
  const drawer = pane(window).locator('[data-testid="file-pane-drawer"]');
  await expect(drawer).toHaveAttribute("data-mode", "scm");
  const changes = drawer.locator('[data-testid="scm-group-changes"]');
  await expect(changes.locator('[data-testid="scm-group-count"]').first()).toHaveText(String(FILES + 1));
  const row = (p: string) => changes.locator(`[data-testid="scm-row"][data-path="${p}"]`);
  await expect(row(many(0))).toBeVisible();
  await expect(row(many(0))).toHaveAttribute("data-letter", "M");
  await window.screenshot({ path: shot(testInfo, "scm-scale-list") });

  // The list scrolls to its last row.
  const last = row(many(FILES - 1));
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeVisible();
  await expect(last).toHaveAttribute("data-letter", "M");

  // The big file's diff: drawn within a few seconds, not a freeze.
  const bigRow = row("src/big.ts");
  await bigRow.scrollIntoViewIfNeeded();
  const opened = Date.now();
  await bigRow.locator("button").first().click();
  const editor = pane(window).locator('[data-testid="file-pane-editor"]');
  await expect(pane(window).locator('[data-testid="file-pane-diff-tag"]')).toHaveText("Diff vs HEAD", {
    timeout: 5_000,
  });
  const firstInserted = editor.locator(".cm-changedLine", { hasText: "line 0 of the big change" });
  await expect(firstInserted).toBeVisible({ timeout: 5_000 });
  const drawnIn = Date.now() - opened;
  testInfo.annotations.push({ type: "big diff drawn in", description: `${drawnIn} ms` });
  await window.screenshot({ path: shot(testInfo, "scm-scale-diff") });

  // Typing into it shows up promptly.
  await firstInserted.click();
  await window.keyboard.press("End");
  const typed = Date.now();
  await window.keyboard.type("Q");
  await expect(editor.locator(".cm-line", { hasText: "line 0 of the big change\";Q" })).toBeVisible({
    timeout: 1_000,
  });
  testInfo.annotations.push({ type: "keystroke shown in", description: `${Date.now() - typed} ms` });
  await expect(header(window).locator('[data-testid="file-pane-dirty"]')).toBeVisible();
});
