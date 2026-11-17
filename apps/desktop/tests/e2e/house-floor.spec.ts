import fs from "fs";
import path from "path";

import type { Locator, Page } from "@playwright/test";

import { bootWorkspaceWithTerminal, expect, importSeededProject, test as base } from "./fixtures";
import { FAKE_AGENT } from "./helpers/fake-agent";
import { waitForVisibleSession } from "./helpers/local-api";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";
import { useTheme } from "./helpers/theme";

/**
 * The house floor (#703), end to end: the Agents list ends in a floor of
 * sockets that today's stats fill. Locked while filling (a sweep feeds
 * nothing), it wakes when full; sweeping feeds every dot, Settle plays, and
 * the house has eaten one more meal.
 *
 * Today's stats are seeded on disk before launch: 30 agents killed, 60
 * points, which is also the whole week, so a floor takes the minimum 60
 * points. The floor's own state (`manor:houseFloor`) is then written into
 * the renderer's storage with a high-water mark below today's points, and
 * a reload banks the difference: 30 points for a half floor, 60 for full.
 */

const SHOTS = path.join(__dirname, "artifacts", "house-floor");
const FLOOR_KEY = "manor:houseFloor";
const SEED = 12_345;
const TODAY_POINTS = 60;

/** Local YYYY-MM-DD, as `StatsStore` keys its days. */
function localDay(ms = Date.now()): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Mirrors `statsFile()` in electron/paths.ts. */
function statsFile(tempHome: string): string {
  const dataDir =
    process.platform === "darwin"
      ? path.join(tempHome, "Library", "Application Support", "Manor")
      : path.join(tempHome, ".local", "share", "Manor");
  return path.join(dataDir, "stats.json");
}

const test = base.extend({
  tempHome: async ({ tempHome }, use) => {
    fs.mkdirSync(path.dirname(statsFile(tempHome)), { recursive: true });
    fs.writeFileSync(
      statsFile(tempHome),
      JSON.stringify({ version: 1, days: { [localDay()]: { agentsKilled: TODAY_POINTS / 2 } }, badges: {} }),
    );
    await use(tempHome);
  },
});

interface StoredFloor {
  day: string;
  todayMax: number;
  progress: number;
  pointsPerFloor: number;
  meals: number;
  seed: number;
}

const floor = (w: Page) => w.getByTestId("house-floor");
const canvas = (w: Page) => w.getByTestId("house-floor").locator("canvas");

function storedFloor(w: Page): Promise<StoredFloor | null> {
  return w.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as StoredFloor) : null;
  }, FLOOR_KEY);
}

/**
 * Writes the floor's state with `todayMax` below today's points, gives the
 * Agents list room for the whole floor, and reloads: the reload banks
 * `TODAY_POINTS - todayMax`.
 */
async function seedFloor(w: Page, todayMax: number, meals: number): Promise<void> {
  const value: StoredFloor = {
    day: localDay(),
    todayMax,
    progress: 0,
    pointsPerFloor: TODAY_POINTS,
    meals,
    seed: SEED,
  };
  await w.evaluate(
    ([key, json]) => {
      localStorage.setItem(key, json);
      localStorage.setItem("manor:agentsHeight", "400");
      localStorage.setItem("manor:agentsCollapsed", "false");
    },
    [FLOOR_KEY, JSON.stringify(value)] as const,
  );
  await w.reload();
  await w.waitForLoadState("domcontentloaded");
  await expect(floor(w)).toBeVisible({ timeout: 30_000 });
}

async function dots(w: Page): Promise<{ dots: number; size: number }> {
  const c = canvas(w);
  return {
    dots: Number(await c.getAttribute("data-dots")),
    size: Number(await c.getAttribute("data-floor-size")),
  };
}

async function shoot(target: Locator, file: string): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  await target.screenshot({ path: path.join(SHOTS, file) });
}

/**
 * Hover the mouse across the floor in row bands, top to bottom, over the
 * part of the canvas between `from` and `to` (fractions of its height) and
 * `leftFrom` and `leftTo` (fractions of its width). Every band is a fresh
 * pass for the dots under it.
 */
async function sweep(w: Page, from = 0, to = 1, leftFrom = 0, leftTo = 1): Promise<void> {
  const c = canvas(w);
  await c.scrollIntoViewIfNeeded();
  const box = await c.boundingBox();
  if (!box) throw new Error("house floor canvas has no box");
  const top = box.y + box.height * from;
  const bottom = box.y + box.height * to;
  const left = box.x + Math.max(4, box.width * leftFrom);
  const right = box.x + Math.min(box.width - 4, box.width * leftTo);
  for (let y = top + 6, row = 0; y <= bottom - 4; y += 20, row++) {
    const [x0, x1] = row % 2 === 0 ? [left, right] : [right, left];
    await w.mouse.move(x0, y);
    await w.mouse.move(x1, y, { steps: 24 });
    // Stop the moment the floor is clear, so Settle is caught from its start.
    if ((await c.getAttribute("data-state")) === "settle") return;
  }
  // Off the floor: the next sweep starts a fresh pass everywhere.
  await w.mouse.move(box.x + box.width / 2, box.y - 40);
}

/** Feed the awake floor in this theme: awake, mid-feed and Settle shots. */
async function feedOneMeal(w: Page, theme: "dark" | "light", meals: number): Promise<void> {
  await seedFloor(w, 0, meals);
  await useTheme(w, theme === "dark" ? "Catppuccin Mocha" : "Catppuccin Latte");
  const { dots: full, size } = await dots(w);
  expect(full).toBe(size);
  await expect(canvas(w)).toHaveAttribute("data-state", "awake", { timeout: 10_000 });
  await expect(canvas(w)).toHaveAttribute("aria-label", `House floor: ${size} of ${size}, awake, sweep to feed`);
  // Past the wake swell, into the breath.
  await w.waitForTimeout(2_000);
  await shoot(floor(w), `awake-${theme}.png`);

  // Mid-feed: the left half swept clean (dots take up to three passes), the
  // right half untouched. `data-left` counts the dots still on the floor
  // (`data-dots` is the floor's fill, which stays full until it's eaten).
  await expect(canvas(w)).toHaveAttribute("data-left", String(size));
  const left = async () => Number(await canvas(w).getAttribute("data-left"));
  await expect(async () => {
    await sweep(w, 0, 1, 0, 0.42);
    expect(await left()).toBeLessThanOrEqual(Math.ceil(size * 0.6));
  }).toPass({ timeout: 30_000 });
  const midway = await left();
  expect(midway).toBeLessThan(size);
  expect(midway).toBeGreaterThanOrEqual(Math.floor(size * 0.3));
  await expect(canvas(w)).toHaveAttribute("data-state", "awake");
  await shoot(floor(w), `mid-feed-${theme}.png`);

  // The rest, until the floor is clear and the house answers.
  await expect(async () => {
    await sweep(w);
    await expect(canvas(w)).toHaveAttribute("data-state", "settle", { timeout: 500 });
  }).toPass({ timeout: 60_000 });
  await expect(canvas(w)).toHaveAttribute("aria-label", "House floor: fed, the house answers");
  // The sigil formed and holding (Settle is 3.6s; the sweep stops as it starts).
  await w.waitForTimeout(1_200);
  await shoot(floor(w), `settle-${theme}.png`);

  // The meal was eaten as Settle began: one floor of points gone, one more
  // meal, a new seed.
  const after = (await storedFloor(w))!;
  expect(after.meals).toBe(meals + 1);
  expect(after.progress).toBe(0);
  expect(after.seed).not.toBe(SEED);
  // Once the house has answered, with nothing carried over and no live
  // agents, the empty floor hides with the section; feeding touched no stats.
  await expect(floor(w)).toHaveCount(0, { timeout: 8_000 });
  const today = await w.evaluate(() => window.electronAPI.stats.getSummary());
  expect(today.today.agentsKilled).toBe(TODAY_POINTS / 2);
}

test.describe("house floor", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  test.beforeAll(() => {
    fs.rmSync(SHOTS, { recursive: true, force: true });
    fs.mkdirSync(SHOTS, { recursive: true });
  });

  test("a fresh install shows an empty floor of sockets under the agents", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    await bootWorkspaceWithTerminal(app, window, tempHome, "house-floor");
    const paneId = await activePaneId(window);
    await awaitShellReady(window, tempHome, paneId);
    await runInTerminal(window, `"${FAKE_AGENT}" floor-agent`);
    await waitForVisibleSession(request, tempHome, { name: "floor-agent" });

    await expect(floor(window)).toBeVisible({ timeout: 30_000 });
    // The first run starts empty, whatever today already holds.
    await expect(canvas(window)).toHaveAttribute("data-dots", "0");
    await expect(canvas(window)).toHaveAttribute("data-state", "filling");
    const { size } = await dots(window);
    expect(size % 1).toBe(0);
    expect(size).toBeGreaterThanOrEqual(180);
    expect(size).toBeLessThanOrEqual(220);
    await expect.poll(async () => (await storedFloor(window))?.todayMax).toBe(TODAY_POINTS);

    await useTheme(window, "Catppuccin Mocha");
    await shoot(floor(window), "fresh-dark.png");
    await useTheme(window, "Catppuccin Latte");
    await shoot(floor(window), "fresh-light.png");
  });

  test("a part-filled floor is locked, keeps the section up, and marks a folded header", async ({
    app,
    window,
    tempHome,
  }) => {
    await importSeededProject(app, window, tempHome);
    await seedFloor(window, TODAY_POINTS / 2, 0);
    const { dots: half, size } = await dots(window);
    expect(half).toBe(Math.floor(size / 2));
    await expect(canvas(window)).toHaveAttribute("data-state", "filling");
    await expect(canvas(window)).toHaveAttribute("aria-label", `House floor: ${half} of ${size}, filling`);
    // No live agents, but dots on the floor: the section shows.
    await expect(window.locator('[data-testid="sidebar-agent-row"]')).toHaveCount(0);
    const header = window.getByTestId("sidebar-agents-header");
    await expect(header).toBeVisible();

    await useTheme(window, "Catppuccin Mocha");
    await shoot(floor(window), "locked-dark.png");
    await useTheme(window, "Catppuccin Latte");
    await shoot(floor(window), "locked-light.png");

    // Locked: sweeping feeds nothing.
    const before = await storedFloor(window);
    for (let i = 0; i < 3; i++) await sweep(window);
    expect((await dots(window)).dots).toBe(half);
    await expect(canvas(window)).toHaveAttribute("data-state", "filling");
    expect(await storedFloor(window)).toEqual(before);

    // Folded: a faint marker in the header.
    await header.click();
    await expect(floor(window)).toHaveCount(0);
    const marker = window.getByTestId("house-floor-marker");
    await expect(marker).toBeVisible();
    await expect(marker).toHaveAttribute("data-state", "filling");
    await useTheme(window, "Catppuccin Mocha");
    await shoot(header, "folded-marker-dark.png");
    await useTheme(window, "Catppuccin Latte");
    await shoot(header, "folded-marker-light.png");
    await header.click();
    await expect(floor(window)).toBeVisible();
  });

  test("a full floor wakes, feeds to clear, plays Settle, and the house eats a meal", async ({
    app,
    window,
    tempHome,
  }) => {
    await importSeededProject(app, window, tempHome);
    await feedOneMeal(window, "dark", 0);
    await feedOneMeal(window, "light", 1);

    // Awake and folded: the marker says so.
    await seedFloor(window, 0, 2);
    await window.getByTestId("sidebar-agents-header").click();
    await expect(window.getByTestId("house-floor-marker")).toHaveAttribute("data-state", "awake");
  });
});
