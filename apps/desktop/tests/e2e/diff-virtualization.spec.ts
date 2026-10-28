import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";
import { createWorkspace, importSeededProject, test, expect } from "./fixtures";

/**
 * The diff pane builds only the rows near the screen (#411). Everything that
 * used to find a row on the page — search, jump to comment, copying a
 * selection — has to reach rows that are not built yet.
 */

/** Rows in the far file: well past one screen plus overscan. */
const FAR_LINES = 900;

test("only rows near the screen are built", async ({
  app,
  window,
  tempHome,
}) => {
  test.setTimeout(180_000);
  await bootDiff(app, window, tempHome);

  const built = await window.locator("[data-diff-lines] [data-index]").count();
  // Two files of ~1,800 rows between them; a screen and its overscan is a
  // few dozen.
  expect(built).toBeGreaterThan(10);
  expect(built).toBeLessThan(300);
});

test("search reaches a match in a row that is not built", async ({
  app,
  window,
  tempHome,
}) => {
  test.setTimeout(180_000);
  await bootDiff(app, window, tempHome);

  await window.getByTitle("Search in diff").click();
  await window.getByPlaceholder("Find...").fill("zqneedle");
  // Two matches: the first row of a.ts, and the last row of far.ts. Previous
  // from the first wraps to the last, which starts out unbuilt.
  await expect(window.locator("mark[data-match-index]").first()).toBeVisible({
    timeout: 10_000,
  });
  await window.getByLabel("Previous match").click();

  const last = window.locator('mark[data-match-index="1"]');
  await expect(last).toBeInViewport({ timeout: 10_000 });
  const row = await last.evaluate(
    (el) => el.closest<HTMLElement>("[data-index]")?.dataset.index,
  );
  expect(Number(row)).toBeGreaterThan(FAR_LINES);
});

test("jumping to a comment reaches a row that is not built", async ({
  app,
  window,
  tempHome,
}) => {
  test.setTimeout(180_000);
  await bootDiff(app, window, tempHome);

  // Comment on the last row of far.ts: reach it through search, select it,
  // and start a comment from the keyboard.
  await window.getByTitle("Search in diff").click();
  await window.getByPlaceholder("Find...").fill("zqneedle");
  await window.getByLabel("Previous match").click();
  await expect(window.locator('mark[data-match-index="1"]')).toBeInViewport({
    timeout: 10_000,
  });
  await window.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    const row = document
      .querySelector('mark[data-match-index="1"]')
      ?.closest("[data-index]");
    const range = document.createRange();
    range.selectNodeContents(row!.children[1]);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await window.keyboard.press("ControlOrMeta+Enter");
  await window.getByPlaceholder("Leave a comment…").fill("far away note");
  await window.getByRole("button", { name: "Add comment" }).click();
  const card = window.locator("[data-comment-id]");
  await expect(card).toBeVisible();

  // Back to the top: the card's row is no longer built.
  await window.getByLabel("Close search").click();
  await scrollPaneTo(window, 0);
  await expect(card).toHaveCount(0);

  await window.getByLabel("Jump to a comment").click();
  await window.getByRole("button", { name: /far away note/ }).click();
  await expect(card).toBeInViewport({ timeout: 10_000 });
});

test("copying a long drag selection includes rows that are not built", async ({
  app,
  window,
  tempHome,
}) => {
  test.setTimeout(180_000);
  await bootDiff(app, window, tempHome);

  // Start the drag on an early row of far.ts...
  await window.evaluate(() =>
    document.querySelector('[data-file-path="far.ts"]')?.scrollIntoView(),
  );
  const start = window.locator(
    '[data-file-path="far.ts"] [data-index="3"] > :nth-child(2)',
  );
  await expect(start).toBeVisible();
  const box = (await start.boundingBox())!;
  await window.mouse.move(box.x + 30, box.y + 5);
  await window.mouse.down();
  await window.mouse.move(box.x + 90, box.y + 5, { steps: 4 });
  await window.mouse.up();

  // ...scroll far down the file, which unbuilds every row between, and
  // carry the selection's end there. (Continuing the drag itself across the
  // scroll is what a hand does; Playwright's synthetic mouse loses a drag
  // across a programmatic scroll in plain Chromium too, so the end is placed
  // with the Selection API.)
  await scrollPaneTo(window, 30_000);
  const builtFar = await window
    .locator('[data-file-path="far.ts"] [data-index]')
    .count();
  expect(builtFar).toBeLessThan(300);
  await window.evaluate(() => {
    const cells = Array.from(
      document.querySelectorAll(
        '[data-file-path="far.ts"] [data-index] > :nth-child(2)',
      ),
    ).filter((c) => c.textContent?.includes("far2-"));
    const cell = cells[cells.length - 1];
    const text = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    let node: Node | null = null;
    while (text.nextNode()) node = text.currentNode;
    window.getSelection()!.extend(node!, 1);
  });

  const { lastIndex, firstIndex } = await window.evaluate(() => {
    const sel = window.getSelection()!;
    const index = (node: Node | null) => {
      const el = node instanceof Element ? node : node?.parentElement;
      return Number(el?.closest<HTMLElement>("[data-index]")?.dataset.index);
    };
    return {
      firstIndex: index(sel.anchorNode),
      lastIndex: index(sel.focusNode),
    };
  });
  expect(firstIndex).toBe(3);
  expect(lastIndex).toBeGreaterThan(300);

  await window.keyboard.press("ControlOrMeta+c");
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), {
      timeout: 5_000,
    })
    .toContain("far.ts");
  const text = await app.evaluate(({ clipboard }) => clipboard.readText());
  const lines = text.split("\n");
  expect(lines[0]).toBe("far.ts");
  // One line per row from the start row through the end row, every one of
  // them, built or not.
  expect(lines.length - 1).toBe(lastIndex - firstIndex + 1);
  expect(text).toContain('"far-100"');
});

async function scrollPaneTo(window: Page, top: number): Promise<void> {
  await window.evaluate((y) => {
    const target = Array.from(document.querySelectorAll<HTMLElement>("*")).find(
      (el) =>
        el.scrollHeight > el.clientHeight + 500 &&
        /auto|scroll/.test(getComputedStyle(el).overflowY) &&
        el.querySelector("[data-diff-lines]"),
    );
    if (target) target.scrollTop = y;
  }, top);
  await window.waitForTimeout(300);
}

async function bootDiff(
  app: Parameters<typeof importSeededProject>[0],
  window: Page,
  tempHome: string,
): Promise<void> {
  await importSeededProject(app, window, tempHome);
  await createWorkspace(window, "diff-virtual");
  const worktree = await waitForWorktree(tempHome);

  const lines = (n: number, gen: string) =>
    Array.from({ length: n }, (_, i) => `export const v${i} = "${gen}-${i}";`);
  fs.writeFileSync(
    path.join(worktree, "a.ts"),
    lines(20, "a").join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(worktree, "far.ts"),
    lines(FAR_LINES, "far").join("\n") + "\n",
  );
  git(worktree, "add -A");
  git(worktree, 'commit -qm "baseline"');

  const a = lines(20, "a");
  a[0] = `export const v0 = "zqneedle";`;
  fs.writeFileSync(path.join(worktree, "a.ts"), a.join("\n") + "\n");
  const far = lines(FAR_LINES, "far2");
  far[FAR_LINES - 1] = `export const last = "zqneedle";`;
  fs.writeFileSync(path.join(worktree, "far.ts"), far.join("\n") + "\n");

  await window.keyboard.press("ControlOrMeta+Shift+g");
  await expect(
    window.locator("[data-diff-lines] [data-index]").first(),
  ).toBeVisible({ timeout: 60_000 });
}

async function waitForWorktree(tempHome: string): Promise<string> {
  const root = path.join(tempHome, ".manor", "worktrees");
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fs.existsSync(root)) {
      for (const project of fs.readdirSync(root)) {
        for (const ws of fs.readdirSync(path.join(root, project))) {
          const dir = path.join(root, project, ws);
          if (fs.existsSync(path.join(dir, ".git"))) return dir;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no worktree under ${root}`);
}

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Manor E2E",
      GIT_AUTHOR_EMAIL: "test@manor-e2e.local",
      GIT_COMMITTER_NAME: "Manor E2E",
      GIT_COMMITTER_EMAIL: "test@manor-e2e.local",
    },
  });
}
