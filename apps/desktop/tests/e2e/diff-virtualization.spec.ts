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

/**
 * Rows in the far file: well past one screen plus overscan, and under the
 * 1,000 changed lines that would start it collapsed.
 */
const FAR_LINES = 900;

test("only rows near the screen are built", async ({
  app,
  window,
  tempHome,
}) => {
  test.setTimeout(180_000);
  await bootDiff(app, window, tempHome);

  const built = await window.locator("[data-diff-lines] [data-index]").count();
  // Two files of ~900 rows between them; a screen and its overscan is a
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
  // Two matches: the first row of a.ts, and the last row of far.ts, which
  // starts out unbuilt. Next goes from the first to the second.
  await expect(window.locator("mark[data-match-index]").first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(window.locator('mark[data-match-index="1"]')).toHaveCount(0);
  await window.getByLabel("Next match").click();

  const last = window.locator('mark[data-match-index="1"]');
  await expect(last).toHaveClass(/searchMatchActive/, { timeout: 10_000 });
  await expect(last).toBeInViewport({ timeout: 10_000 });
  const row = await last.evaluate(
    (el) => el.closest<HTMLElement>("[data-index]")?.dataset.index,
  );
  expect(Number(row)).toBeGreaterThan(FAR_LINES - 10);
  await window.screenshot({
    path: test.info().outputPath("search-far-match.png"),
  });
});

test("a small diff builds every row, and scrolling never shows a gap", async ({
  app,
  window,
  tempHome,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  window.on("pageerror", (e) => errors.push(e.message));
  window.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await bootDiff(app, window, tempHome);

  // a.ts's few rows are all built, as before.
  const smallRows = window.locator('[data-file-path="a.ts"] [data-index]');
  const indices = await smallRows.evaluateAll((rows) =>
    rows.map((r) => Number((r as HTMLElement).dataset.index)),
  );
  expect(indices.length).toBeGreaterThan(2);
  expect(indices).toEqual(indices.map((_, i) => i));

  // Wheel down through far.ts at a reading pace; at every stop, wherever
  // far.ts is on screen, a row is drawn there — never empty space.
  const pane = (await window
    .locator('[data-file-path="far.ts"]')
    .boundingBox())!;
  await window.mouse.move(pane.x + pane.width / 2, 400);
  let sampled = 0;
  for (let step = 0; step < 50; step++) {
    await window.mouse.wheel(0, 360);
    await window.waitForTimeout(60);
    const gaps = await window.evaluate(() => {
      const file = document.querySelector('[data-file-path="far.ts"]')!;
      const box = file.getBoundingClientRect();
      const header = file.firstElementChild!.getBoundingClientRect();
      const scroller = file.closest<HTMLElement>("[class*=container]")!;
      const view = scroller.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const missing: number[] = [];
      let points = 0;
      for (
        let y = Math.max(view.top, box.top) + 40;
        y < Math.min(view.bottom, box.bottom) - 4;
        y += 37
      ) {
        if (y < header.bottom + 2) continue;
        points++;
        const el = document.elementFromPoint(x, y);
        if (!el?.closest("[data-index]") && !el?.closest("[class*=fileHeader]"))
          missing.push(Math.round(y));
      }
      return { missing, points };
    });
    sampled += gaps.points;
    expect(gaps.missing, `blank space in far.ts at step ${step}`).toEqual([]);
  }
  // The check looked at a lot of the file, not at nothing.
  expect(sampled).toBeGreaterThan(300);
  expect(errors.filter((e) => /Maximum update depth|#185/.test(e))).toEqual([]);
  expect(errors).toEqual([]);
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
  await window.screenshot({
    path: test.info().outputPath("jumped-to-comment.png"),
  });
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
  expect(text).toContain('"far2-100"');

  // Comment on selection anchors the same whole range.
  await window.keyboard.press("ControlOrMeta+Enter");
  await expect(window.getByPlaceholder("Leave a comment…")).toBeVisible();
  await expect(
    window.locator("[data-diff-lines]").getByText(`L3–L${lastIndex}`),
  ).toBeVisible();
});

test("a selection scrolled out of view still copies its own rows", async ({
  app,
  window,
  tempHome,
}) => {
  test.setTimeout(180_000);
  await bootDiff(app, window, tempHome);

  // Select rows 3–8 of far.ts with a drag...
  await window.evaluate(() =>
    document.querySelector('[data-file-path="far.ts"]')?.scrollIntoView(),
  );
  const cell = (i: number) =>
    window.locator(
      `[data-file-path="far.ts"] [data-index="${i}"] > :nth-child(2)`,
    );
  const from = (await cell(3).boundingBox())!;
  const to = (await cell(8).boundingBox())!;
  await window.mouse.move(from.x + 30, from.y + 5);
  await window.mouse.down();
  await window.mouse.move(to.x + 60, to.y + 5, { steps: 6 });
  await window.mouse.up();

  // ...scroll far away, so neither end is anywhere near the screen...
  await scrollPaneTo(window, 30_000);

  // ...and copy: still rows 3–8, not whatever rows are built now.
  await window.keyboard.press("ControlOrMeta+c");
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), {
      timeout: 5_000,
    })
    .toContain("far.ts");
  const lines = (
    await app.evaluate(({ clipboard }) => clipboard.readText())
  ).split("\n");
  expect(lines).toHaveLength(1 + 6);
  expect(lines[1]).toContain('"far2-2"');
});

test("huge and generated files start collapsed, and a choice holds", async ({
  app,
  window,
  tempHome,
}) => {
  test.setTimeout(180_000);
  await importSeededProject(app, window, tempHome);
  await createWorkspace(window, "diff-collapse");
  const worktree = await waitForWorktree(tempHome);

  const lines = (n: number, gen: string) =>
    Array.from(
      { length: n },
      (_, i) => `export const v${i} = "${gen}-${i}";`,
    ).join("\n") + "\n";
  const lock = (gen: string) =>
    Array.from(
      { length: 40 },
      (_, i) => `  pkg-${i}@1.0.${gen}:\n    resolution: x`,
    ).join("\n") + "\n";
  fs.writeFileSync(path.join(worktree, "pnpm-lock.yaml"), lock("0"));
  fs.writeFileSync(path.join(worktree, "small.ts"), lines(300, "small"));
  git(worktree, "add -A");
  git(worktree, 'commit -qm "baseline"');
  fs.writeFileSync(path.join(worktree, "pnpm-lock.yaml"), lock("1"));
  fs.writeFileSync(path.join(worktree, "small.ts"), lines(300, "small2"));
  fs.writeFileSync(path.join(worktree, "big.ts"), lines(1500, "big"));
  git(worktree, "add big.ts");

  await window.keyboard.press("ControlOrMeta+Shift+g");
  const file = (name: string) => window.locator(`[data-file-path="${name}"]`);
  const showAll = (name: string) =>
    file(name).getByRole("button", { name: /^Show all [\d,]+ lines$/ });

  await expect(showAll("big.ts")).toBeVisible({ timeout: 60_000 });
  await expect(showAll("big.ts")).toHaveText("Show all 1,500 lines");
  await expect(showAll("pnpm-lock.yaml")).toBeVisible();
  await expect(file("big.ts").locator("[data-index]")).toHaveCount(0);
  await expect(showAll("small.ts")).toHaveCount(0);
  await expect(file("small.ts").locator("[data-index]").first()).toBeVisible();

  await file("big.ts").scrollIntoViewIfNeeded();
  await window.screenshot({
    path: test.info().outputPath("collapsed-dark.png"),
  });
  await useLightTheme(window);
  await window.waitForTimeout(800);
  await window.screenshot({
    path: test.info().outputPath("collapsed-light.png"),
  });

  // Expanding is remembered as the agent keeps editing.
  await showAll("big.ts").click();
  await expect(file("big.ts").locator("[data-index]").first()).toBeVisible();
  await expect(showAll("big.ts")).toHaveCount(0);
  await window.screenshot({
    path: test.info().outputPath("expanded-light.png"),
  });

  fs.writeFileSync(path.join(worktree, "big.ts"), lines(1501, "big"));
  // One more line in small.ts says the diff has refreshed.
  fs.writeFileSync(path.join(worktree, "small.ts"), lines(301, "small3"));
  await expect(file("small.ts")).toContainText("+301", { timeout: 30_000 });
  await expect(showAll("big.ts")).toHaveCount(0);
  await expect(file("big.ts").locator("[data-index]").first()).toBeVisible();
});

/**
 * Catppuccin Latte, the light half of Manor's default palette. Selected by
 * name; a throwaway profile may not have the theme list loaded, so its
 * colours are applied directly if selecting it changed nothing.
 */
async function useLightTheme(window: Page): Promise<void> {
  const bg = () =>
    window.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--bg")
        .trim(),
    );
  const before = await bg();
  await window
    .evaluate(() => window.electronAPI.theme.setSelected("Catppuccin Latte"))
    .catch(() => {});
  await window.waitForTimeout(800);
  if ((await bg()) !== before) return;
  await window.evaluate(() => {
    const latte: Record<string, string> = {
      "--bg": "#eff1f5",
      "--fg": "#4c4f69",
      "--dim": "#e6e9ef",
      "--surface": "#ccd0da",
      "--hover": "#dce0e8",
      "--border": "#bcc0cc",
      "--text": "#4c4f69",
      "--text-primary": "#4c4f69b3",
      "--text-selected": "#4c4f69",
      "--text-dim": "#4c4f6980",
      "--accent": "#1e66f5",
      "--blue": "#1e66f5",
      "--green": "#40a02b",
      "--red": "#d20f39",
    };
    for (const [k, v] of Object.entries(latte))
      document.documentElement.style.setProperty(k, v);
    document.documentElement.style.colorScheme = "light";
  });
}

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

test("clicking a file in the list scrolls to the top of that file", async ({
  app,
  window,
  tempHome,
}) => {
  test.setTimeout(180_000);
  // Several big files ahead of the target: on the way past them their rows
  // build and measure, and a smooth scroll used to stop a screen or so in.
  await bootDiff(app, window, tempHome, (worktree, lines) => {
    for (const name of ["b1", "b2", "b3", "b4"]) {
      fs.writeFileSync(
        path.join(worktree, `${name}.ts`),
        lines(FAR_LINES, name).join("\n") + "\n",
      );
    }
    git(worktree, "add b1.ts b2.ts b3.ts b4.ts");
    fs.writeFileSync(
      path.join(worktree, "zz.ts"),
      lines(400, "zz").join("\n") + "\n",
    );
    git(worktree, "add zz.ts");
  });

  await window.locator('span[title="zz.ts"]').first().click();

  const target = window.locator('[data-file-path="zz.ts"]');
  await expect(target).toBeInViewport({ timeout: 10_000 });
  // The file's top sits just under the pane's sticky header, and stays there.
  await expect
    .poll(
      () =>
        target.evaluate((el) => {
          // The pane is the scroller that carries its header's height.
          let pane = el.parentElement;
          while (pane && !pane.style.getPropertyValue("--diff-header-offset"))
            pane = pane.parentElement;
          if (!pane) return Infinity;
          const headerBottom =
            pane.getBoundingClientRect().top +
            parseFloat(pane.style.getPropertyValue("--diff-header-offset"));
          return Math.abs(el.getBoundingClientRect().top - headerBottom);
        }),
      { timeout: 10_000 },
    )
    .toBeLessThan(2);
  await window.waitForTimeout(500);
  const firstRow = await target
    .locator("[data-index]")
    .first()
    .getAttribute("data-index");
  expect(firstRow).toBe("0");
  await window.screenshot({
    path: test.info().outputPath("scroll-to-file.png"),
  });
});

async function bootDiff(
  app: Parameters<typeof importSeededProject>[0],
  window: Page,
  tempHome: string,
  more?: (
    worktree: string,
    lines: (n: number, gen: string) => string[],
  ) => void,
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
  git(worktree, "add -A");
  git(worktree, 'commit -qm "baseline"');

  const a = lines(20, "a");
  a[0] = `export const v0 = "zqneedle";`;
  fs.writeFileSync(path.join(worktree, "a.ts"), a.join("\n") + "\n");
  // A new file: every line an added row.
  const far = lines(FAR_LINES, "far2");
  far[FAR_LINES - 1] = `export const last = "zqneedle";`;
  fs.writeFileSync(path.join(worktree, "far.ts"), far.join("\n") + "\n");
  git(worktree, "add far.ts");
  more?.(worktree, lines);

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
