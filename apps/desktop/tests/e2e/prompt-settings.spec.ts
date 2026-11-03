import fs from "fs";
import path from "path";

import type { Page, TestInfo } from "@playwright/test";

import { expect, test } from "./fixtures";
import { closeSettings, openSettings } from "./helpers/settings";
import { useTheme } from "./helpers/theme";

/**
 * Settings › Prompts: every prompt listed by group, one edited with a
 * placeholder inserted at the cursor, the editor's warnings, and Reset.
 * Photographed dark and light; screenshots go to the test's output dir, and to
 * $SHOT_DIR when it is set.
 */

async function shot(window: Page, testInfo: TestInfo, name: string): Promise<void> {
  const file = testInfo.outputPath(`${name}.png`);
  await window.waitForTimeout(300);
  await window.screenshot({ path: file, animations: "disabled" });
  const dir = process.env.SHOT_DIR;
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, path.join(dir, `${name}.png`));
  }
}

const savedEdits = (window: Page) =>
  window.evaluate(async () => (await window.electronAPI.preferences.getAll()).promptOverrides);

test("Settings › Prompts edits what agents are told, warns, and resets", async ({ window }, testInfo) => {
  await useTheme(window, "Catppuccin Mocha");
  await openSettings(window);
  await window.getByTestId("settings-nav-prompts").click();

  const list = window.getByTestId("prompts-list");
  await expect(list).toBeVisible();
  await expect(list.locator("button")).toHaveCount(11);
  await shot(window, testInfo, "prompts-list-dark");

  // Edit a prompt: typing saves it, and a placeholder goes in at the cursor.
  await window.getByTestId("prompt-card-prConflicts").click();
  const text = window.getByTestId("prompt-text");
  const original = await text.inputValue();
  expect(original).toContain("{{pr}}");
  await text.fill("Merge the base into this branch, then run pnpm test. ");
  await text.press("End");
  await window.getByTestId("prompt-placeholder-pr").click();
  await expect(text).toHaveValue("Merge the base into this branch, then run pnpm test. {{pr}}");
  await expect
    .poll(() => savedEdits(window))
    .toEqual({ prConflicts: "Merge the base into this branch, then run pnpm test. {{pr}}" });

  // Warnings: a placeholder this prompt lacks, one left out, and blank.
  await text.fill("Merge {{nope}}");
  const notes = window.getByTestId("prompt-notes");
  await expect(notes).toContainText("{{nope}} isn't a placeholder here");
  await expect(notes).toContainText("Agents won't get {{pr}}");
  await shot(window, testInfo, "prompt-editor-warnings-dark");

  await text.fill("   ");
  await expect(notes).toContainText("can't be blank");
  await shot(window, testInfo, "prompt-editor-blank-dark");
  await expect.poll(() => savedEdits(window)).toEqual({ prConflicts: "Merge {{nope}}" });

  // The list marks what's edited, in both themes.
  await text.fill("Merge the base into this branch, then run pnpm test. {{pr}}");
  await window.getByTestId("prompt-back").click();
  await expect(window.getByTestId("prompt-card-prConflicts")).toContainText("Edited");
  await expect(window.getByTestId("prompt-card-prConflicts")).toContainText("run pnpm test");
  await useTheme(window, "Catppuccin Latte");
  await shot(window, testInfo, "prompts-list-edited-light");

  await window.getByTestId("prompt-card-prConflicts").click();
  await shot(window, testInfo, "prompt-editor-light");

  // Reset forgets the edit and shows the default again.
  await window.getByTestId("prompt-reset").click();
  await expect(text).toHaveValue(original);
  await expect.poll(() => savedEdits(window)).toEqual({});
  await expect(window.getByTestId("prompt-reset")).toBeDisabled();
  await window.getByTestId("prompt-back").click();
  await expect(window.getByTestId("prompt-card-prConflicts")).not.toContainText("Edited");

  // A session hint can be blank, which means none.
  await window.getByTestId("prompt-card-sessionHint").click();
  await text.fill("");
  await expect(window.getByTestId("prompt-notes")).toContainText("Agents will get no hint");
  await expect.poll(() => savedEdits(window)).toEqual({ sessionHint: "" });
  await useTheme(window, "Catppuccin Mocha");
  await shot(window, testInfo, "prompt-editor-hint-blank-dark");
  await window.getByTestId("prompt-reset").click();
  await expect.poll(() => savedEdits(window)).toEqual({});

  await closeSettings(window);
});

test("the write guard holds in the running app", async ({ window }) => {
  const refused = await window.evaluate(() =>
    (window.electronAPI.preferences.set as (k: string, v: unknown) => Promise<void>)(
      "promptOverrides",
      { issue: "Something else" },
    ).then(
      () => false,
      () => true,
    ),
  );
  expect(refused).toBe(true);
  expect(
    await window.evaluate(async () => (await window.electronAPI.preferences.getAll()).promptOverrides),
  ).toEqual({});
});
