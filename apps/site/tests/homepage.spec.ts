import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * What on the homepage would quietly cost downloads if it broke, end to end
 * against the production build: the Download button, the phone layout, and the
 * hero's slideshow. Slideshow tests hold for any number of tabs, so slides can
 * be added without touching them.
 */
const VERSION = (JSON.parse(fs.readFileSync(new URL("../../desktop/package.json", import.meta.url), "utf8")) as { version: string }).version;

async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  return errors;
}

test.describe("desktop 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Download points at the .dmg of the version it names", async ({ page }) => {
    await open(page);
    const buttons = page.locator('a[href$=".dmg"]');
    await expect(buttons).toHaveCount(3);
    for (const b of await buttons.all()) {
      await expect(b).toHaveAttribute("href", `https://github.com/orrybaram/manor/releases/download/v${VERSION}/Manor-arm64.dmg`);
    }
    await expect(page.locator(".hero .meta")).toContainText(`v${VERSION}`);
    await expect(page.locator(".foot a.btn")).toContainText(`v${VERSION}`);
  });
});

test.describe("phone 390", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

  test("no sideways scroll and the headline's first line stays on one line", async ({ page }) => {
    const errors = await open(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    const l1 = page.locator(".omen-h .ln").first();
    const lineHeight = await l1.evaluate((el) => parseFloat(getComputedStyle(el).fontSize) * 1.5);
    expect((await l1.boundingBox())!.height).toBeLessThan(lineHeight);
    expect(errors).toEqual([]);
  });
});

// ---- the hero slideshow ----------------------------------------------------

const tabs = (page: Page) => page.locator('.slideshow [role="tab"]');
const openTab = (page: Page) => page.locator('.slideshow [role="tab"][aria-selected="true"]');
const toggle = (page: Page) => page.locator(".slideshow-toggle");

/** How far the open tab's progress line has run, 0 to 1. */
const progress = (page: Page) =>
  page
    .locator('.slideshow [role="tab"][aria-selected="true"] .slideshow-progress')
    .evaluate((bar) => new DOMMatrix(getComputedStyle(bar).transform).a);

/** Bring the whole window on screen and move the pointer off the slideshow. */
async function windowOnScreen(page: Page) {
  await page.mouse.move(0, 0);
  await page.locator(".slideshow .shot").evaluate((shot) => shot.scrollIntoView({ block: "center", behavior: "instant" }));
}

const scrollTo = (page: Page, y: number) => page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), y);

const expectRunning = async (page: Page) => {
  const from = await progress(page);
  await expect.poll(() => progress(page), { timeout: 3000 }).not.toBe(from);
};

/** Holds still: read after anything in flight has landed, then again later. */
const expectHeld = async (page: Page) => {
  await page.waitForTimeout(150);
  const from = await progress(page);
  await page.waitForTimeout(500);
  expect(await progress(page)).toBe(from);
};

/** Claude's "Composing… (38s" timer, which only a fresh slide puts back to 38. */
const composingSecs = async (page: Page) =>
  Number((await page.locator('.slideshow [data-pane="hero"] .ma-term').innerText()).match(/\((\d+)s/)?.[1]);

test.describe("slideshow at 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the tabs follow the tabs pattern and the first is open", async ({ page }) => {
    const errors = await open(page);
    await expect(page.locator('.slideshow [role="tablist"]')).toHaveAttribute("aria-label", "Manor features");
    await expect(tabs(page).first()).toHaveText("Side by side");
    await expect(tabs(page).first()).toHaveAttribute("aria-selected", "true");
    await expect(tabs(page).first()).toHaveAttribute("tabindex", "0");
    const panel = page.getByRole("tabpanel");
    await expect(panel).toHaveAttribute("aria-labelledby", (await tabs(page).first().getAttribute("id"))!);
    await expect(page.locator(".slideshow-text")).toContainText("Try it:");
    await expect(page.locator(".slideshow-text b")).not.toBeEmpty();
    expect(errors).toEqual([]);
  });

  test("progress runs on screen, and stops off screen or with the tab hidden", async ({ page }) => {
    const errors = await open(page);
    await windowOnScreen(page);
    await expectRunning(page);

    await scrollTo(page, 3000);
    await expectHeld(page);

    await windowOnScreen(page);
    await expectRunning(page);

    const setHidden = (hidden: boolean) =>
      page.evaluate((value) => {
        Object.defineProperty(document, "hidden", { value, configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      }, hidden);
    await setHidden(true);
    await expectHeld(page);
    await setHidden(false);
    await expectRunning(page);
    expect(errors).toEqual([]);
  });

  test("the window has to be a fifth on screen for progress to run, which it is on load at 1440×900", async ({ page }) => {
    await open(page);
    await windowOnScreen(page);
    const shot = (await page.locator(".slideshow .shot").boundingBox())!;
    const top = (await page.evaluate(() => window.scrollY)) + shot.y;
    // Scroll so this share of the window shows below the viewport's top edge.
    const show = (share: number) => scrollTo(page, top + shot.height * (1 - share));
    await show(0.1);
    await expectHeld(page);
    await show(0.3);
    await expectRunning(page);

    await scrollTo(page, 0);
    await expectRunning(page);
  });

  test("hover pauses and leaving resumes", async ({ page }) => {
    await open(page);
    await windowOnScreen(page);
    await expectRunning(page);
    await page.locator(".slideshow .shot").hover();
    await expectHeld(page);
    await expect(toggle(page)).toHaveText("Pause"); // Only paused: still meant to play.
    await page.mouse.move(0, 0);
    await expectRunning(page);
  });

  test("keyboard focus inside pauses, and leaving resumes", async ({ page }) => {
    await open(page);
    await windowOnScreen(page);
    await expectRunning(page);
    await page.getByRole("tabpanel").focus();
    await expectHeld(page);
    await page.locator(".hero .gh-plain").focus();
    await windowOnScreen(page);
    await expectRunning(page);
  });

  test("clicking a tab stops it for good, and Play resumes", async ({ page }) => {
    await open(page);
    await windowOnScreen(page);
    const text = page.locator(".slideshow-text");
    await expect(text).toHaveAttribute("aria-live", "off");
    await expect(toggle(page)).toHaveAccessibleName("Pause automatic slideshow");

    await tabs(page).first().click();
    await page.mouse.move(0, 0);
    await expectHeld(page);
    await expect(toggle(page)).toHaveAccessibleName("Play automatic slideshow");
    await expect(toggle(page)).toHaveText("Play");
    await expect(text).toHaveAttribute("aria-live", "polite");

    await toggle(page).click();
    await page.mouse.move(0, 0);
    await expectRunning(page);
    await expect(toggle(page)).toHaveAccessibleName("Pause automatic slideshow");
    await expect(text).toHaveAttribute("aria-live", "off");

    await toggle(page).click();
    await page.mouse.move(0, 0);
    await expectHeld(page);
  });

  test("Play from the keyboard runs even with focus left on the button", async ({ page }) => {
    await open(page);
    await windowOnScreen(page);
    await toggle(page).focus();
    await toggle(page).press("Enter"); // Pause
    await expectHeld(page);
    await toggle(page).press("Enter"); // Play
    await expectRunning(page);
  });

  test("answering Codex in the window stops autoplay and the answer stays", async ({ page }) => {
    const errors = await open(page);
    await windowOnScreen(page);
    const codex = page.locator('.slideshow [data-pane="gtf"] .ma-term');
    await codex.locator('[data-act="yes"]').click();
    await expect(codex).toContainText("Ran pnpm vitest run FileTree");
    await page.mouse.move(0, 0);
    await expect(toggle(page)).toHaveText("Play");
    await expectHeld(page);
    await expect(codex).toContainText("18 passed", { timeout: 5000 });
    // Picking the open tab again doesn't wipe it.
    await openTab(page).click();
    await expect(codex).toContainText("18 passed");
    expect(errors).toEqual([]);
  });

  test("after its 8s a slide hands over to the next tab, wrapping round, and keeps its state if it's alone", async ({ page }) => {
    test.setTimeout(20_000);
    await open(page);
    await windowOnScreen(page);
    const n = await tabs(page).count();
    const secs = await composingSecs(page);
    const nextId = await tabs(page).nth(1 % n).getAttribute("id");
    await expect.poll(() => progress(page), { timeout: 9000, intervals: [100] }).toBeGreaterThan(0.9);
    await expect.poll(() => progress(page), { timeout: 3000, intervals: [100] }).toBeLessThan(0.5);
    await expect(openTab(page)).toHaveAttribute("id", nextId!);
    if (n === 1) expect(await composingSecs(page)).toBeGreaterThan(secs + 5);
  });

  test("no autoplay under reduced motion, and it reacts when that changes", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors = await open(page);
    await windowOnScreen(page);
    await expect(toggle(page)).toHaveText("Play");
    await expect(page.locator(".slideshow-text")).toHaveAttribute("aria-live", "polite");
    await expectHeld(page);
    expect(await progress(page)).toBe(0);

    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(toggle(page)).toHaveText("Pause");
    await expectRunning(page);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(toggle(page)).toHaveText("Play");
    await expectHeld(page);

    // Having stopped it themselves, a visitor doesn't get it back when the setting lifts.
    await tabs(page).first().click();
    await page.mouse.move(0, 0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(toggle(page)).toHaveText("Play");
    await expectHeld(page);
    expect(errors).toEqual([]);
  });

  test("arrow keys, Home and End move and select, with one tab in the tab order", async ({ page }) => {
    await open(page);
    const n = await tabs(page).count();
    const expectOpen = async (i: number) => {
      await expect(tabs(page).nth(i)).toHaveAttribute("aria-selected", "true");
      await expect(tabs(page).nth(i)).toBeFocused();
      await expect(page.locator('.slideshow [role="tab"][tabindex="0"]')).toHaveCount(1);
      await expect(tabs(page).nth(i)).toHaveAttribute("tabindex", "0");
      await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", (await tabs(page).nth(i).getAttribute("id"))!);
    };
    await tabs(page).first().focus();
    await page.keyboard.press("ArrowRight");
    await expectOpen(1 % n);
    await page.keyboard.press("ArrowLeft");
    await expectOpen(0);
    await page.keyboard.press("ArrowLeft");
    await expectOpen(n - 1);
    await page.keyboard.press("Home");
    await expectOpen(0);
    await page.keyboard.press("End");
    await expectOpen(n - 1);
    await expect(toggle(page)).toHaveText("Play");
  });

  test("the keys only act on the tabs, and leave the page's alone", async ({ page }) => {
    await open(page);
    const first = await tabs(page).first().getAttribute("id");
    await page.locator(".hero .gh-plain").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("End");
    await expect(openTab(page)).toHaveAttribute("id", first!);
    await expect(toggle(page)).toHaveText("Pause");

    // A horizontal tab row leaves Up and Down to the page.
    await tabs(page).first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(openTab(page)).toHaveAttribute("id", first!);
  });

  test("Ctrl+K opens the page's terminal from the tabs and from inside the window", async ({ page }) => {
    const errors = await open(page);
    const term = page.locator(".term");
    await tabs(page).first().focus();
    await page.keyboard.press("Control+k");
    await expect(term).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(term).toBeHidden();

    await page.locator('.slideshow [data-pane="suite"]').click();
    await page.keyboard.press("Control+k");
    await expect(term).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("a key the slide takes stops autoplay as a click does, so the hand-off can't wipe it", async ({ page }) => {
    await open(page);
    await page.locator('.slideshow [data-pane="suite"]').click();
    await toggle(page).focus();
    await toggle(page).press("Enter"); // Play from the keyboard, so the pane keeps the keys.
    await page.locator(".hero .gh-plain").focus();
    await windowOnScreen(page);
    await expect(toggle(page)).toHaveText("Pause");
    await expectRunning(page);
    await page.keyboard.type("hi");
    await expect(page.locator('.slideshow [data-pane="suite"] .ma-term')).toContainText("hi");
    await expect(toggle(page)).toHaveText("Play");
    await expectHeld(page);
  });

  test("a key the slide leaves alone doesn't stop autoplay", async ({ page }) => {
    await open(page);
    await windowOnScreen(page);
    await page.keyboard.press("x");
    await expect(toggle(page)).toHaveText("Pause");
    await expectRunning(page);
  });

  test("the page's terminal holds the slideshow while it's open", async ({ page }) => {
    await open(page);
    await windowOnScreen(page);
    await expectRunning(page);
    await page.keyboard.press("Control+k");
    await expect(page.locator(".term")).toBeVisible();
    await expectHeld(page);
    await expect(toggle(page)).toHaveText("Pause"); // Only held: still meant to play.
    await page.keyboard.press("Escape");
    await expect(page.locator(".term")).toBeHidden();
    await expectRunning(page);
  });

  test("under reduced motion, Play advances the slides and nothing inside one moves by itself", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page);
    await windowOnScreen(page);
    const secs = await composingSecs(page);
    await toggle(page).click();
    await page.mouse.move(0, 0);
    await expectRunning(page);
    await page.waitForTimeout(1500);
    expect(await composingSecs(page)).toBe(secs);
  });

  test("typing into a pane stays in the pane, and not while the keyboard is on the controls", async ({ page }) => {
    await open(page);
    const suite = page.locator('.slideshow [data-pane="suite"] .ma-term');
    await page.locator('.slideshow [data-pane="suite"]').click();
    await page.keyboard.type("hi");
    await expect(suite).toContainText("hi");
    await toggle(page).focus();
    await page.keyboard.type("zz");
    await expect(suite).not.toContainText("hizz");
  });

  test("the traffic lights sit in the lead of every window, clear of its buttons", async ({ page }) => {
    await open(page);
    await expect(page.locator(".ma-lights")).toHaveCount(3);
    const root = page.locator(".slideshow .mapp");
    const scale = await root.evaluate((el) => el.getBoundingClientRect().width / 1280);
    const lights = page.locator(".slideshow .ma-lights span");
    const box = (await root.boundingBox())!;
    const expected = [13, 33, 53];
    for (const [i, x] of expected.entries()) {
      const b = (await lights.nth(i).boundingBox())!;
      expect((b.x - box.x) / scale).toBeCloseTo(x, 0);
      expect(b.width / scale).toBeCloseTo(12, 0);
      expect((b.y + b.height / 2 - box.y) / scale).toBeCloseTo(28, 0);
    }
    const back = (await page.locator('.slideshow .ma-lead-button[aria-label="Navigate back"]').boundingBox())!;
    expect((back.x - box.x) / scale).toBeGreaterThan(65);
    expect((back.y + back.height / 2 - box.y) / scale).toBeCloseTo(28, 0);
  });
});

test.describe("slideshow at 390", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

  test("the tabs scroll in their own box, the page doesn't, and the open tab stays in view", async ({ page }) => {
    const errors = await open(page);
    const pageWidth = () => page.evaluate(() => document.documentElement.scrollWidth);
    expect(await pageWidth()).toBe(390);
    const row = page.locator('.slideshow [role="tablist"]');
    await expect(row).toHaveCSS("overflow-x", "auto");
    const inRow = async () => {
      const r = (await row.boundingBox())!;
      const t = (await openTab(page).boundingBox())!;
      return t.x >= r.x - 1 && t.x + t.width <= r.x + r.width + 1;
    };
    await tabs(page).first().focus();
    await page.keyboard.press("End");
    await expect.poll(inRow).toBe(true);
    expect(await pageWidth()).toBe(390);
    expect(await page.evaluate(() => window.scrollX)).toBe(0);
    await page.keyboard.press("Home");
    await expect.poll(inRow).toBe(true);
    expect(errors).toEqual([]);
  });
});
