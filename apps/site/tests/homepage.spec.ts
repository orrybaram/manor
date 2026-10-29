import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * The homepage's Done list, end to end against the production build.
 * SITE_SHOTS=<dir> also writes the evidence screenshots there.
 */
const SHOTS = process.env.SITE_SHOTS;
const VERSION = (JSON.parse(fs.readFileSync(new URL("../../desktop/package.json", import.meta.url), "utf8")) as { version: string }).version;

async function shot(page: Page, name: string, el?: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${name}.png`);
  if (el) await page.locator(el).first().screenshot({ path: file });
  else await page.screenshot({ path: file });
}

async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("/");
  // Instant jumps, so screenshots never land mid smooth-scroll.
  await page.addStyleTag({ content: "html { scroll-behavior: auto !important; }" });
  await page.evaluate(() => document.fonts.ready);
  return errors;
}

test.describe("desktop 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("renders every section with no console errors", async ({ page }) => {
    const errors = await open(page);
    for (const id of ["top", "stuck", "rooms", "wing"]) await expect(page.locator(`#${id}`)).toBeVisible();
    await expect(page.locator(".hero .tagline")).toContainText("They say coding is dead");
    await shot(page, "1440-hero");
    for (const [id, name] of [["stuck", "1440-ch1"], ["rooms", "1440-ch2"], ["wing", "1440-ch3"]] as const) {
      await page.locator(`#${id}`).scrollIntoViewIfNeeded();
      await shot(page, name, `#${id}`);
    }
    // No screenshot ships: the three app views are live markup.
    await expect(page.locator(".mapp-view .mapp")).toHaveCount(3);
    expect(await page.locator("img[src*='manor.png']").count()).toBe(0);
    expect(errors).toEqual([]);
  });

  test("Download points at the latest .dmg with the desktop version", async ({ page }) => {
    await open(page);
    const buttons = page.locator("a.btn");
    await expect(buttons).toHaveCount(2);
    for (const b of await buttons.all()) {
      await expect(b).toHaveAttribute("href", "https://github.com/orrybaram/manor/releases/latest/download/Manor-arm64.dmg");
      await expect(b).toContainText(`v${VERSION}`);
    }
  });

  test("Codex's Yes moves its status everywhere in the hero shell", async ({ page }) => {
    await open(page);
    const hero = page.locator('[data-shell="hero"]');
    const codexRow = hero.locator('[data-agent="gtf"] .ad');
    await expect(codexRow).toHaveClass(/requires_input/);
    await shot(page, "1440-shell-before", '[data-shell="hero"]');
    await hero.locator('[data-act="yes"]').click({ force: true });
    await expect(codexRow).toHaveClass(/working/);
    await expect(codexRow).toHaveClass(/responded/, { timeout: 5_000 });
    await expect(hero.locator('[data-pane="gtf"] .ma-ph .ad')).toHaveClass(/responded/);
    await expect(hero.locator('[data-pane="gtf"]')).toContainText("18 passed");
    await shot(page, "1440-shell-after", '[data-shell="hero"]');
    // The other mounts keep their own state.
    await expect(page.locator('[data-shell="ask"] [data-act="yes"]')).toHaveCount(1);
  });

  test("the sidebar switches workspaces", async ({ page }) => {
    await open(page);
    const hero = page.locator('[data-shell="hero"]');
    await hero.locator('[data-ws="bench-flood"]').click({ force: true });
    await expect(hero.locator(".ma-tab")).toContainText("bench-flood");
    await expect(hero.locator('[data-pane="flood"]')).toContainText("ECONNREFUSED");
    await shot(page, "1440-shell-switched", '[data-shell="hero"]');
    await hero.locator('[data-agent="hero"]').click({ force: true });
    await expect(hero.locator(".ma-tab")).toContainText("homepage");
  });

  test("typing goes only to a suite pane you clicked, and the page keeps its keys otherwise", async ({ page }) => {
    await open(page);
    // Ch II: picking the suite agent focuses a pane that's cropped out of view;
    // Space must still scroll the page.
    const rooms = page.locator('[data-shell="rooms"]');
    await page.locator("#rooms").scrollIntoViewIfNeeded();
    await rooms.locator('[data-agent="suite"]').click({ force: true });
    const y = await page.evaluate(() => scrollY);
    await page.keyboard.press("Space");
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(y);
    // Hero: clicking the visible suite pane types into it, and only there.
    await page.evaluate(() => scrollTo(0, 0));
    const hero = page.locator('[data-shell="hero"]');
    await hero.locator('[data-pane="suite"]').click();
    await page.keyboard.type("hi");
    await expect(hero.locator('[data-pane="suite"] .inp')).toHaveText("hi");
    await expect(rooms.locator(".inp")).toHaveText("");
  });

  test("the footer is revealed from under the east wing and its webs sweep", async ({ page }) => {
    await open(page);
    const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    await page.evaluate((y) => scrollTo(0, y), max - 450);
    await page.waitForTimeout(300);
    await shot(page, "1440-footer-reveal-mid");
    // Mid-reveal the footer is already pinned to the bottom of the viewport.
    const footBottom = await page.locator("footer.foot").evaluate((f) => Math.round(f.getBoundingClientRect().bottom));
    expect(footBottom).toBe(900);
    await page.evaluate((y) => scrollTo(0, y), max);
    await page.waitForTimeout(300);
    await shot(page, "1440-footer-before");
    const canvas = page.locator("footer.foot canvas");
    const before = await canvas.screenshot();
    const box = (await canvas.boundingBox())!;
    for (let i = 0; i <= 40; i++) await page.mouse.move(box.x + box.width - 40 - i * 14, box.y + 30 + i * 6);
    await page.waitForTimeout(900);
    await shot(page, "1440-footer-after");
    expect(Buffer.compare(before, await canvas.screenshot())).not.toBe(0);
  });

  test("Ctrl+K opens the cellar, help lists commands, Escape closes it", async ({ page }) => {
    await open(page);
    const term = page.locator("#term");
    await expect(term).toBeHidden();
    await page.keyboard.press("Control+k");
    await expect(term).toBeVisible();
    await page.locator("#term-in").fill("help");
    await page.keyboard.press("Enter");
    await expect(page.locator("#term-out")).toContainText("summon");
    await shot(page, "1440-cellar");
    await page.keyboard.press("Escape");
    await expect(term).toBeHidden();
  });
});

test.describe("phone 390", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

  test("no sideways scroll and the tagline's first line stays on one line", async ({ page }) => {
    const errors = await open(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    const l1 = page.locator(".hero .tagline .l1");
    const lineHeight = await l1.evaluate((el) => parseFloat(getComputedStyle(el).fontSize) * 1.3);
    expect((await l1.boundingBox())!.height).toBeLessThan(lineHeight);
    await shot(page, "390-hero");
    for (const id of ["stuck", "rooms", "wing"]) {
      await page.locator(`#${id}`).scrollIntoViewIfNeeded();
      await shot(page, `390-${id}`, `#${id}`);
    }
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(300);
    await shot(page, "390-footer");
    expect(errors).toEqual([]);
  });
});

test.describe("reduced motion", () => {
  test.use({ viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: "reduce" } });

  test("stops scroll motion and the shell's live timers", async ({ page }) => {
    await open(page);
    const anim = await page.locator(".hero .tagline").evaluate((el) => getComputedStyle(el).animationName);
    expect(anim).toBe("none");
    const timer = page.locator('[data-shell="hero"] [data-pane="hero"] .ma-term');
    const first = await timer.innerText();
    await page.waitForTimeout(2_500);
    expect(await timer.innerText()).toBe(first);
  });
});
