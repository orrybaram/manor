import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";
import {
  createWorkspace,
  importSeededProject,
  openTerminalTab,
  test,
  expect,
} from "./fixtures";
import {
  activePaneId,
  awaitShellReady,
  runInTerminal,
} from "./helpers/terminal";
import {
  formatDragPerf,
  readDragProbe,
  RendererCostMeter,
  startDragProbe,
  type DragPerf,
} from "./helpers/drag-perf";

/**
 * Selecting lines in a diff has to feel immediate — it is the first half of
 * every review comment. This measures the thing a user actually perceives:
 * how long the main thread goes without producing a frame while they drag.
 *
 * It is a measurement first and an assertion second. The thresholds are
 * deliberately loose (a CI box is not a laptop) and the numbers are always
 * printed, so a regression shows up as a number moving long before it trips
 * the bound.
 */

/** Files in the seeded diff. Enough to be a real review, not a synthetic one. */
const FILE_COUNT = 6;
/** Lines per file. 6 × 400 ≈ the size of a branch worth reviewing. */
const LINES_PER_FILE = 400;

/**
 * No frame for this long during a drag reads as a hang. 16ms is a frame and an
 * idle pane measures in the low 30s, so this leaves room for a slow machine
 * while still catching the regression it exists to catch: a drag that stops
 * painting for a tenth of a second.
 */
const WORST_FRAME_GAP_BUDGET_MS = 120;
/**
 * The chip is the drag's payoff and it is offered on release, so this is the
 * whole of the wait a user sees at the end of a drag. Measures ~30ms.
 */
const CHIP_BUDGET_MS = 250;
/** Drags per run. One is a coin toss; the median of several is a measurement. */
const DRAGS = 5;
/** Long enough to catch more than one turn of the 5s diff poll. */
const IDLE_WATCH_MS = 13_000;
/** An untouched pane should never cost a frame at all. */
const IDLE_FRAME_GAP_BUDGET_MS = 100;

test("drag-selecting a large diff keeps producing frames", async ({
  app,
  window,
  tempHome,
}) => {
  test.setTimeout(180_000);

  // A console being written to during a drag is both a cost in itself and the
  // thing that makes DevTools unusable on this pane, so count it rather than
  // assume it is quiet.
  const console_ = countConsole(window);

  await bootLargeDiff(app, window, tempHome);
  const median = await measureAndReport(app, window, "idle pane");
  console.log(console_.report());
  await profileOneDrag(app, window, "idle pane");

  expect(
    median,
    `the renderer typically went ${Math.round(median)}ms without a frame mid-drag`,
  ).toBeLessThan(WORST_FRAME_GAP_BUDGET_MS);

  // The chip is hidden on mousedown so it never chases the cursor mid-drag,
  // which puts a document-level listener between the user and its own button.
  // Pressing it has to still open a composer.
  const chip = window.locator('[data-testid="selection-comment-chip"]');
  if ((await chip.count()) === 0 && !(await hasReviewFeature(window))) return;
  await dragOnce(window);
  await expect(chip).toBeVisible({ timeout: 5_000 });
  await chip.getByRole("button", { name: "Comment" }).click();
  await expect(
    window.locator("textarea").first(),
    "clicking the chip did not open a comment composer",
  ).toBeVisible({ timeout: 5_000 });
});

/**
 * Nobody is touching the pane. It should cost nothing.
 *
 * The diff is re-fetched on a timer, and the fetch's `.then` sets state
 * unconditionally — so the pane re-renders on every poll whether or not the
 * diff changed, rebuilding every row of every file. That work does not care
 * that a drag is in flight: it lands in the same main thread, and the
 * selection stops moving until it is done. Watching an idle pane is the
 * cleanest way to see it, with no input to confuse the picture.
 */
test("an idle diff pane does not block the main thread", async ({
  app,
  window,
  tempHome,
}) => {
  test.setTimeout(180_000);

  await bootLargeDiff(app, window, tempHome);

  const meter = await RendererCostMeter.attach(app.context(), window);
  const before = await meter.sample();
  await startDragProbe(window);
  await window.waitForTimeout(IDLE_WATCH_MS);
  const cost = RendererCostMeter.difference(before, await meter.sample());
  const idle = await readDragProbe(window, {
    domRows: 0,
    domNodes: 0,
    cost,
  });
  await meter.detach();

  console.log(
    [
      `── idle pane, ${IDLE_WATCH_MS / 1000}s, no input ──`,
      `  frames produced   ${idle.frames}`,
      `  worst frame gap   ${Math.round(idle.worstFrameGapMs)}ms`,
      `  gaps over 50ms    ${idle.frameGapsMs.length > 0 ? idle.frameGapsMs.join(", ") + "ms" : "none"}`,
      `  long tasks        ${idle.longTasks.length}`,
      ...idle.longTasks.map(
        (t) => `      +${t.startMs}ms for ${t.durationMs}ms`,
      ),
      `  renderer spent    ${cost.scriptMs}ms script, ${cost.recalcStyleMs}ms style, ${cost.layoutMs}ms layout`,
    ].join("\n"),
  );

  expect(
    idle.worstFrameGapMs,
    `an untouched diff pane dropped a frame for ${Math.round(idle.worstFrameGapMs)}ms`,
  ).toBeLessThan(IDLE_FRAME_GAP_BUDGET_MS);
});

/**
 * The same drag, in a window where a terminal is streaming — which is what a
 * diff pane is actually next to in Manor, and the difference between the
 * measurement above and the one a user reports.
 *
 * A terminal pane is an xterm canvas being repainted from a WebGL renderer on
 * the same main thread as the diff. If a drag stops feeling instant the moment
 * something else in the window is busy, the diff pane's own cost is not the
 * problem and no amount of trimming it will help.
 */
test("drag-selecting stays responsive while a terminal streams", async ({
  app,
  window,
  tempHome,
}) => {
  test.setTimeout(240_000);

  await bootLargeDiff(app, window, tempHome);

  // A terminal in its own tab, flooding. `yes` is the cheapest way to keep a
  // pty saturated, and the renderer then has to draw every frame of it.
  await openTerminalTab(window);
  const paneId = await activePaneId(window);
  await awaitShellReady(window, tempHome, paneId);
  await runInTerminal(window, "yes 'streaming output from a busy agent pane'");
  await window.waitForTimeout(1_000);

  // Back to the diff tab, with the flood still running behind it.
  await window.keyboard.press("Meta+Shift+g");
  await expect(window.locator("[data-diff-lines]").first()).toBeVisible({
    timeout: 30_000,
  });

  await measureAndReport(app, window, "terminal streaming");
  await profileOneDrag(app, window, "terminal streaming");
  console.log(
    `[perf] NOTE: compare this against the idle-pane run — a large gap here means the\n       jank is main-thread contention from the rest of the window, not the diff.`,
  );
});

/** Boot a workspace whose worktree carries a large diff, and open the pane. */
async function bootLargeDiff(
  app: Parameters<typeof importSeededProject>[0],
  window: Page,
  tempHome: string,
): Promise<void> {
  await importSeededProject(app, window, tempHome);
  await createWorkspace(window, "diff-perf");

  const worktree = await waitForWorktree(tempHome);
  seedLargeDiff(worktree);

  await openDiffPane(window);

  const rows = window.locator("[data-diff-lines] [data-index]");
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  // The diff is fetched on an interval, so wait for the whole thing to land
  // rather than racing the first render.
  await expect
    .poll(() => rows.count(), { timeout: 30_000 })
    .toBeGreaterThan(LINES_PER_FILE);
}

/** Run the drag `DRAGS` times, print every run, and return the median worst gap. */
async function measureAndReport(
  app: Parameters<typeof RendererCostMeter.attach>[0] extends never
    ? never
    : Parameters<typeof importSeededProject>[0],
  window: Page,
  label: string,
): Promise<number> {
  const meter = await RendererCostMeter.attach(app.context(), window);
  const runs: DragPerf[] = [];
  for (let i = 0; i < DRAGS; i++) {
    runs.push(await measureDrag(window, meter));
    // Clear the selection, and leave a beat so one drag's tail does not land
    // inside the next drag's measurement.
    await window.evaluate(() => document.getSelection()?.removeAllRanges());
    await window.waitForTimeout(400);
  }
  await meter.detach();

  for (const [i, run] of runs.entries()) {
    console.log(formatDragPerf(`${label} — drag ${i + 1} of ${DRAGS}`, run));
  }

  const worstGaps = runs.map((r) => r.worstFrameGapMs).sort((a, b) => a - b);
  const median = worstGaps[Math.floor(worstGaps.length / 2)];
  console.log(
    `\n── summary (${label}) ──\n  worst frame gap per drag  ${worstGaps.map((g) => Math.round(g) + "ms").join(", ")}\n  median                    ${Math.round(median)}ms\n`,
  );

  const chipLatencies = runs
    .map((r) => r.chipAfterReleaseMs)
    .filter((v): v is number => v !== null);
  console.log(
    `  chip after release        ${chipLatencies.map((v) => Math.round(v) + "ms").join(", ")}\n`,
  );

  expect(
    runs.every((r) => r.firstSelectionMs !== null),
    "a drag produced no selection",
  ).toBe(true);
  // A build without the review feature has no chip to wait for; the drag
  // numbers above are still the comparable ones, which is what lets this run
  // against a revision that predates it.
  if (chipLatencies.length > 0) {
    expect(chipLatencies.length, "only some drags produced a chip").toBe(
      runs.length,
    );
    expect(
      Math.max(...chipLatencies),
      "the comment chip was slow to appear after the drag ended",
    ).toBeLessThan(CHIP_BUDGET_MS);
  }
  return median;
}

/**
 * Drag from the middle of one row to a row well below it, in small steps, the
 * way a hand does. Steps matter: one long jump measures a single hit-test,
 * while twenty short ones measure what the user is complaining about.
 */
async function measureDrag(
  window: Page,
  meter: RendererCostMeter,
): Promise<DragPerf> {
  const { from, to } = await pickDragRows(window);

  const domCounts = await window.evaluate(() => {
    const pane = document.querySelector("[data-diff-lines]")?.closest("div");
    return {
      domRows: document.querySelectorAll("[data-diff-lines] [data-index]")
        .length,
      domNodes: pane
        ? (pane.parentElement?.querySelectorAll("*").length ?? 0)
        : 0,
    };
  });

  await window.mouse.move(from.x, from.y);

  const costBefore = await meter.sample();
  await startDragProbe(window);
  await window.mouse.down();

  // A trackpad reports at 60–120Hz, so a second-long drag is well over a
  // hundred mousemoves and as many `selectionchange` events. Playwright sends
  // one move per call, so driving this with a couple of dozen calls measures a
  // drag five times slower than a hand's — which is exactly the sampling rate
  // at which the problem disappears. `steps` is what restores it: each call
  // fans out into that many real moves.
  const legs = 12;
  for (let i = 1; i <= legs; i++) {
    const ratio = i / legs;
    await window.mouse.move(
      from.x + (to.x - from.x) * ratio,
      from.y + (to.y - from.y) * ratio,
      { steps: 12 },
    );
  }
  await window.mouse.up();

  // Give the chip's rAF-scheduled evaluation a chance to land before reading.
  await window.waitForTimeout(500);

  const cost = RendererCostMeter.difference(costBefore, await meter.sample());

  // What the window costs on its own, over a span as long as the drag. Sampled
  // right after, with the mouse still, so the load is the same.
  const perf = await readDragProbe(window, { ...domCounts, cost });
  const idleBefore = await meter.sample();
  await window.waitForTimeout(perf.dragMs);
  perf.idleCost = RendererCostMeter.difference(
    idleBefore,
    await meter.sample(),
  );
  return perf;
}

/** Tally everything the renderer writes to its console, by type and by text. */
function countConsole(window: Page): { report: () => string } {
  const byType = new Map<string, number>();
  const samples = new Map<string, number>();

  window.on("console", (message) => {
    const type = message.type();
    byType.set(type, (byType.get(type) ?? 0) + 1);
    const text = message.text().slice(0, 120);
    samples.set(text, (samples.get(text) ?? 0) + 1);
  });
  window.on("pageerror", (error) => {
    byType.set("pageerror", (byType.get("pageerror") ?? 0) + 1);
    const text = String(error.message).slice(0, 120);
    samples.set(text, (samples.get(text) ?? 0) + 1);
  });

  return {
    report: () => {
      const total = [...byType.values()].reduce((a, b) => a + b, 0);
      const lines = [`── console traffic ──`, `  ${total} messages total`];
      for (const [type, count] of byType) lines.push(`  ${type}: ${count}`);
      const loudest = [...samples.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);
      for (const [text, count] of loudest) {
        lines.push(`  ×${count}  ${text}`);
      }
      return lines.join("\n");
    },
  };
}

/**
 * One more drag, this time under the sampling profiler, printing the functions
 * that actually burned the time. A frame clock says *that* a drag is slow; this
 * says *what* is making it slow, which is the only thing you can act on.
 */
async function profileOneDrag(
  app: Parameters<typeof importSeededProject>[0],
  window: Page,
  label: string,
): Promise<void> {
  // Resolve the drag's endpoints *before* sampling starts. `pickDragRows`
  // hit-tests every row on screen, and its `elementFromPoint` calls would
  // otherwise sit near the top of the profile as the test's own cost.
  const { from, to } = await pickDragRows(window);

  const meter = await RendererCostMeter.attach(app.context(), window);
  await meter.startProfile();
  await window.mouse.move(from.x, from.y);
  await window.mouse.down();
  for (let i = 1; i <= 12; i++) {
    const ratio = i / 12;
    await window.mouse.move(
      from.x + (to.x - from.x) * ratio,
      from.y + (to.y - from.y) * ratio,
      { steps: 12 },
    );
  }
  await window.mouse.up();
  const hot = await meter.stopProfile();
  await meter.detach();
  await window.evaluate(() => document.getSelection()?.removeAllRanges());

  console.log(
    [`── hottest frames during one drag (${label}) ──`, ...hot].join("\n"),
  );
}

/** Whether this build ships the inline-review chip at all. */
async function hasReviewFeature(window: Page): Promise<boolean> {
  await dragOnce(window);
  const present =
    (await window.locator('[data-testid="selection-comment-chip"]').count()) >
    0;
  await window.evaluate(() => document.getSelection()?.removeAllRanges());
  return present;
}

/** The same drag, unmeasured — for tests that only want a live selection. */
async function dragOnce(window: Page): Promise<void> {
  const { from, to } = await pickDragRows(window);
  await window.mouse.move(from.x, from.y);
  await window.mouse.down();
  await window.mouse.move(to.x, to.y, { steps: 12 });
  await window.mouse.up();
}

/**
 * Two points inside the diff's *code* text, a good many rows apart and both
 * clear of the sticky header. Resolved with `elementFromPoint` rather than
 * from a row's box: a point that lands on the header, the gutter or a gap
 * between rows starts no selection at all, and a drag that selects nothing
 * measures nothing.
 */
async function pickDragRows(window: Page): Promise<{
  from: { x: number; y: number; tag: string };
  to: { x: number; y: number; tag: string };
}> {
  const points = await window.evaluate(() => {
    const cells = Array.from(
      document.querySelectorAll<HTMLElement>("[data-diff-lines] [data-index]"),
    )
      .map((row) => row.children[1] as HTMLElement | undefined)
      .filter((cell): cell is HTMLElement => !!cell && cell.textContent !== "");

    const hits: { x: number; y: number; tag: string }[] = [];
    for (const cell of cells) {
      const box = cell.getBoundingClientRect();
      if (box.height === 0 || box.top < 120) continue;
      if (box.bottom > window.innerHeight - 80) continue;
      const x = box.left + 40;
      const y = box.top + box.height / 2;
      const el = document.elementFromPoint(x, y);
      if (!el || !cell.contains(el)) continue;
      hits.push({ x, y, tag: el.tagName.toLowerCase() });
    }
    return hits;
  });

  if (points.length < 6)
    throw new Error(`only ${points.length} selectable code cells on screen`);
  return { from: points[1], to: points[points.length - 2] };
}

/** Cmd+Shift+G, then wait for the pane to exist. */
async function openDiffPane(window: Page): Promise<void> {
  await window.keyboard.press("Meta+Shift+g");
  await expect(window.locator("[data-diff-lines]").first()).toBeVisible({
    timeout: 60_000,
  });
}

/**
 * The worktree a new workspace gets. Created by the main process a moment
 * after the dialog closes, so this polls rather than assuming it is there.
 */
async function waitForWorktree(tempHome: string): Promise<string> {
  const root = path.join(tempHome, ".manor", "worktrees");
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = firstWorktree(root);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`no worktree appeared under ${root}`);
}

function firstWorktree(root: string): string | null {
  if (!fs.existsSync(root)) return null;
  for (const project of fs.readdirSync(root)) {
    const projectDir = path.join(root, project);
    if (!fs.statSync(projectDir).isDirectory()) continue;
    for (const workspace of fs.readdirSync(projectDir)) {
      const dir = path.join(projectDir, workspace);
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
    }
  }
  return null;
}

/**
 * Commit a set of files, then rewrite them — which is what makes `git diff`
 * report a large, realistic change rather than a pile of untracked files it
 * would not show at all.
 *
 * Half the files are `.ts` (the syntax highlighter has a grammar for them) and
 * half are `.gd` (it does not), so the measurement covers both the tokenized
 * and the plain-text render paths.
 */
function seedLargeDiff(worktree: string): void {
  const names = Array.from({ length: FILE_COUNT }, (_, i) =>
    i % 2 === 0 ? `module-${i}.ts` : `module-${i}.gd`,
  );

  for (const name of names) {
    fs.writeFileSync(path.join(worktree, name), body(name, "before"));
  }
  git(worktree, "add -A");
  git(worktree, 'commit -m "seed perf fixture"');

  for (const name of names) {
    fs.writeFileSync(path.join(worktree, name), body(name, "after"));
  }
}

function body(name: string, generation: string): string {
  const lines: string[] = [];
  for (let i = 0; i < LINES_PER_FILE; i++) {
    lines.push(
      `const value_${i} = { id: ${i}, name: "${generation}-${name}-${i}", enabled: ${i % 3 === 0} };`,
    );
  }
  return lines.join("\n") + "\n";
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
