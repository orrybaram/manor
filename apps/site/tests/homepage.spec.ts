import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * What on the homepage would quietly cost downloads if it broke, end to end
 * against the production build: the Download button, the phone layout, and the
 * hero's slideshow. Slideshow frame tests hold for two tabs or more, so slides
 * can be added without touching them.
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

const MOCHA_BG = "#1e1e2e";
const MANOR_BG = "#181616";
const LATTE_BG = "#eff1f5";
const TOKYONIGHT_BG = "#1a1b26";
const DRACULA_BG = "#282a36";

/** A theme token as the window has it now. */
const cssVar = (page: Page, name: string) =>
  page.locator(".slideshow .mapp").evaluate((el, n) => getComputedStyle(el).getPropertyValue(n).trim(), name);

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

  test("after its 8s a slide hands over to the next tab", async ({ page }) => {
    test.setTimeout(20_000);
    await open(page);
    await windowOnScreen(page);
    await expect(tabs(page).nth(1)).toHaveText("Themes");
    await expect.poll(() => progress(page), { timeout: 9000, intervals: [100] }).toBeGreaterThan(0.9);
    await expect.poll(() => progress(page), { timeout: 3000, intervals: [100] }).toBeLessThan(0.5);
    await expect(openTab(page)).toHaveText("Themes");
    await expect(page.locator(".slideshow-text b")).toHaveText("A different look for each project.");
  });

  test("the last slide wraps round to the first, which comes back fresh in its own colours", async ({ page }) => {
    test.setTimeout(20_000);
    await open(page);
    await tabs(page).last().click();
    await windowOnScreen(page);
    await toggle(page).click();
    await page.mouse.move(0, 0);
    await expect(openTab(page)).toHaveAttribute("id", (await tabs(page).first().getAttribute("id"))!, { timeout: 10_000 });
    expect(await composingSecs(page)).toBeLessThan(40);
    expect(await cssVar(page, "--bg")).toBe(MOCHA_BG);
  });

  test("a slide's state resets on re-entry, and what it left pending never lands", async ({ page }) => {
    await open(page);
    const codex = page.locator('.slideshow [data-pane="gtf"] .ma-term');
    await codex.locator('[data-act="yes"]').click(); // Finishes itself 1.8s later.
    await expect(codex).toContainText("Ran pnpm vitest run FileTree");
    await tabs(page).nth(1).click();
    await expect(page.locator(".ma-settings-modal")).toBeVisible();
    await page.waitForTimeout(2200);
    // Landing here would have redrawn the old slide over this one.
    await expect(page.locator(".ma-settings-modal")).toBeVisible();
    await tabs(page).first().click();
    await expect(codex.locator('[data-act="yes"]')).toBeVisible();
    await expect(codex).not.toContainText("Ran pnpm vitest run FileTree");
    await page.waitForTimeout(2200);
    await expect(codex).not.toContainText("18 passed");
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

test.describe("the Themes slide", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const trigger = (page: Page) => page.locator("[data-theme-trigger]");
  const rows = (page: Page) => page.locator(".ma-select-option");
  const search = (page: Page) => page.locator(".ma-select-search");
  const project = (page: Page, id: string) => page.locator(`[data-settings-project="${id}"]`);
  const pick = async (page: Page, label: string) => {
    await trigger(page).click();
    await rows(page).filter({ hasText: label }).click();
    await expect(search(page)).toHaveCount(0);
  };

  async function openThemes(page: Page) {
    const errors = await open(page);
    await page.locator("#slide-tab-themes").click();
    await windowOnScreen(page);
    await expect(page.locator(".ma-settings-modal")).toBeVisible();
    return errors;
  }

  test("each project repaints the window in its own theme, and its swatch follows the app's logic", async ({ page }) => {
    const errors = await openThemes(page);
    const root = page.locator(".slideshow .mapp");
    expect(await cssVar(page, "--bg")).toBe(MANOR_BG);
    await expect(root).toHaveCSS("color-scheme", "dark");
    await expect(page.locator('.ma-settings-page input[data-name]')).toHaveValue("harbor");

    await project(page, "almanac").click();
    expect(await cssVar(page, "--bg")).toBe(LATTE_BG);
    await expect(root).toHaveCSS("color-scheme", "light");
    await expect(page.locator('.ma-settings-page input[data-name]')).toHaveValue("almanac");
    await expect(trigger(page)).toContainText("Catppuccin Latte");
    await expect(page.locator('[data-project="almanac"] .ma-project-swatch')).toHaveCSS("background-color", "rgb(234, 118, 203)"); // Latte's magenta

    await project(page, "lantern").click();
    expect(await cssVar(page, "--bg")).toBe(TOKYONIGHT_BG);
    await expect(root).toHaveCSS("color-scheme", "dark");
    // No colour of its own: the swatch is --text-dim, as the app's fallback.
    const dim = await page.locator('[data-project="lantern"] .ma-project-swatch').evaluate((el) => getComputedStyle(el).backgroundColor);
    const toDim = await root.evaluate((el) => {
      const probe = document.createElement("div");
      probe.style.background = "var(--text-dim)";
      el.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
    expect(dim).toBe(toDim);
    expect(errors).toEqual([]);
  });

  test("a picked theme changes only that project, and Global theme is the global one", async ({ page }) => {
    const errors = await openThemes(page);
    await pick(page, "Dracula");
    expect(await cssVar(page, "--bg")).toBe(DRACULA_BG);
    await expect(trigger(page)).toContainText("Dracula");

    await project(page, "almanac").click();
    expect(await cssVar(page, "--bg")).toBe(LATTE_BG);
    await project(page, "lantern").click();
    expect(await cssVar(page, "--bg")).toBe(TOKYONIGHT_BG);
    await project(page, "harbor").click();
    expect(await cssVar(page, "--bg")).toBe(DRACULA_BG);

    await pick(page, "Global theme");
    expect(await cssVar(page, "--bg")).toBe(MOCHA_BG);
    await expect(trigger(page)).toContainText("Global theme");
    await expect(trigger(page)).toContainText("Default");
    await project(page, "almanac").click();
    expect(await cssVar(page, "--bg")).toBe(LATTE_BG);
    expect(errors).toEqual([]);
  });

  test("leaving the slide restores the default colours, and coming back starts over", async ({ page }) => {
    await openThemes(page);
    await project(page, "almanac").click();
    await pick(page, "Dracula");
    await tabs(page).first().click();
    expect(await cssVar(page, "--bg")).toBe(MOCHA_BG);
    await expect(page.locator(".slideshow .mapp")).toHaveCSS("color-scheme", "dark");

    await page.locator("#slide-tab-themes").click();
    expect(await cssVar(page, "--bg")).toBe(MANOR_BG);
    await project(page, "almanac").click();
    expect(await cssVar(page, "--bg")).toBe(LATTE_BG);
  });

  test("search filters the list, and typing stays in the box", async ({ page }) => {
    const errors = await openThemes(page);
    await trigger(page).click();
    await expect(search(page)).toBeFocused();
    await expect(trigger(page)).toHaveAttribute("aria-expanded", "true");
    await expect(rows(page).first()).toContainText("Manor"); // The current choice, pinned first.
    await expect(rows(page)).toHaveCount(14);

    await page.keyboard.type("LIGHT");
    await expect(search(page)).toHaveValue("LIGHT");
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("GitHub Light Default");

    await search(page).fill("zzz");
    await expect(page.locator(".ma-select-empty")).toHaveText("No results");
    await page.keyboard.press("Enter"); // Nothing to pick.
    await expect(search(page)).toBeFocused();

    await search(page).fill("nord");
    await page.keyboard.press("Enter");
    await expect(search(page)).toHaveCount(0);
    expect(await cssVar(page, "--bg")).toBe("#2e3440");
    await expect(openTab(page)).toHaveText("Themes");
    await expect(page.locator(".term")).toBeHidden();
    expect(errors).toEqual([]);
  });

  test("the arrows move the highlight and not the tabs, Esc closes, and the highlight follows the pointer", async ({ page }) => {
    await openThemes(page);
    await trigger(page).click();
    const active = page.locator(".ma-select-active");
    await expect(active).toContainText("Manor");
    await page.keyboard.press("ArrowDown");
    await expect(active).toContainText("Global theme");
    await expect(active).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp"); // Wraps to the end, which scrolls into view.
    await expect(active).toContainText("TokyoNight");
    await expect(active).toBeInViewport();
    await expect(openTab(page)).toHaveText("Themes");

    await rows(page).nth(3).hover();
    await expect(rows(page).nth(3)).toHaveClass(/ma-select-active/);
    await expect(rows(page).nth(3)).toHaveCSS("background-color", "rgb(45, 42, 42)"); // Manor's --surface

    await page.keyboard.press("Escape");
    await expect(search(page)).toHaveCount(0);
    await expect(page.locator(".ma-settings-modal")).toBeVisible(); // One Esc, one layer.
    await expect(trigger(page)).toBeFocused();
    expect(await cssVar(page, "--bg")).toBe(MANOR_BG);

    await page.keyboard.press("ArrowDown"); // From the trigger, as the app's.
    await expect(search(page)).toBeFocused();
  });

  test("clicking outside closes the list, in the window or on the page, and clicking its trigger closes it", async ({ page }) => {
    await openThemes(page);
    await trigger(page).click();
    await page.locator(".ma-settings-title").click();
    await expect(search(page)).toHaveCount(0);

    await trigger(page).click();
    await expect(search(page)).toHaveCount(1);
    await trigger(page).click();
    await expect(search(page)).toHaveCount(0);

    await trigger(page).click();
    await page.locator(".slideshow-text").click();
    await expect(search(page)).toHaveCount(0);
  });

  test("the Name field takes real typing and commits on blur, without a slide key firing", async ({ page }) => {
    await openThemes(page);
    const name = page.locator(".ma-settings-page input[data-name]");
    await name.click();
    await page.keyboard.press("End");
    await page.keyboard.type("-two");
    await expect(name).toHaveValue("harbor-two");
    await expect(openTab(page)).toHaveText("Themes");
    await project(page, "almanac").click(); // Blur and switch in one press.
    await expect(project(page, "almanac")).toHaveAttribute("aria-current", "page");
    await expect(project(page, "harbor")).toHaveText("harbor-two");
    await expect(page.locator('[data-project="harbor"] .ma-project-name')).toHaveText("harbor-two");
  });

  test("a rename moves the worktree default and preview hostname, and Esc mid-rename keeps it", async ({ page }) => {
    await openThemes(page);
    const name = page.locator("[data-name]");
    await name.fill("Salt Marsh!");
    await name.blur();
    await expect(page.locator("[data-worktree-default]")).toHaveText("~/.manor/worktrees/salt-marsh");
    await expect(page.locator('[data-field="worktreePath"]')).toHaveAttribute("placeholder", "~/.manor/worktrees/salt-marsh");
    await expect(page.locator("[data-preview-host]")).toHaveText("salt-marsh.localhost");

    await name.fill("Brine");
    await name.press("Escape");
    await expect(page.locator(".ma-settings-modal")).toHaveCount(0);
    await expect(page.locator('[data-project="harbor"] .ma-project-name')).toHaveText("Brine");
    await expect(page.locator(".ma-status-left .ma-segment").first()).toHaveText("Brine");
  });

  test("New Workspace and New Folder don't collapse the project", async ({ page }) => {
    await openThemes(page);
    await page.locator('[aria-label="Close settings"]').click();
    const project = page.locator('[data-project="harbor"]');
    await project.locator(".ma-project-header").hover();
    await project.getByRole("button", { name: "New Workspace" }).click();
    await project.getByRole("button", { name: "New Folder" }).click();
    await expect(project.locator(".ma-project-body")).toBeVisible();
  });

  test("Ctrl+K still opens the page's terminal from the search box, which closes the list", async ({ page }) => {
    await openThemes(page);
    await trigger(page).click();
    await page.keyboard.press("Control+k");
    await expect(page.locator(".term")).toBeVisible();
    await expect(search(page)).toHaveCount(0);
  });

  test("Settings closes as the app's does, and the sidebar then switches project and reopens it", async ({ page }) => {
    await openThemes(page);
    await page.locator('[aria-label="Close settings"]').click();
    await expect(page.locator(".ma-settings-modal")).toHaveCount(0);
    expect(await cssVar(page, "--bg")).toBe(MANOR_BG);

    await page.locator('[data-project="almanac"] [data-ws="moon-phases"]').click();
    expect(await cssVar(page, "--bg")).toBe(LATTE_BG);
    await expect(page.locator(".slideshow .ma-status-left")).toContainText("almanac");

    const header = page.locator('[data-project="lantern"] .ma-project-header');
    await header.hover();
    await header.locator('[aria-label="Project Settings"]').click();
    await expect(page.locator(".ma-settings-modal")).toBeVisible();
    await expect(page.locator(".ma-settings-page input[data-name]")).toHaveValue("lantern");
    expect(await cssVar(page, "--bg")).toBe(TOKYONIGHT_BG);

    await page.locator(".ma-settings-overlay").click({ position: { x: 40, y: 400 } }); // The dim: back to the workspace's own theme.
    await expect(page.locator(".ma-settings-modal")).toHaveCount(0);
    expect(await cssVar(page, "--bg")).toBe(LATTE_BG);
  });

  test("untouched it plays through the projects, opening nothing, and a click stops that", async ({ page }) => {
    test.setTimeout(20_000);
    await openThemes(page);
    await toggle(page).click();
    await page.mouse.move(0, 0);
    await expect.poll(() => cssVar(page, "--bg"), { timeout: 4000, intervals: [100] }).toBe(LATTE_BG);
    await expect(search(page)).toHaveCount(0);
    await expect(openTab(page)).toHaveText("Themes");
    await expect(project(page, "almanac")).toHaveAttribute("aria-current", "page");

    await project(page, "almanac").click();
    await page.mouse.move(0, 0);
    await expect(toggle(page)).toHaveText("Play");
    await page.waitForTimeout(3200);
    expect(await cssVar(page, "--bg")).toBe(LATTE_BG);
  });

  test("under reduced motion, Play moves on from the slide but doesn't play through the projects", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openThemes(page);
    await toggle(page).click();
    await page.mouse.move(0, 0);
    await expectRunning(page);
    await page.waitForTimeout(3200);
    expect(await cssVar(page, "--bg")).toBe(MANOR_BG);
  });
});

test.describe("the Review slide", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const win = (page: Page) => page.locator(".slideshow .mapp");
  const chip = (page: Page) => win(page).locator(".ma-cm-chip");
  const card = (page: Page) => win(page).locator(".ma-dc[data-comment]");
  const terminal = (page: Page) => win(page).locator('[data-pane="agent"] .ma-term');

  async function openReview(page: Page) {
    const errors = await open(page);
    await page.locator("#slide-tab-review").click();
    await windowOnScreen(page);
    return errors;
  }

  test("it opens on a diff beside the agent, with Comment on a changed line", async ({ page }) => {
    const errors = await openReview(page);
    await expect(chip(page)).toHaveText("+ Comment");
    await expect(win(page).locator(".ma-tab-title")).toHaveText("TideRow.tsx");
    await expect(win(page).locator(".ma-fp-diff-tag")).toHaveText("Diff vs HEAD");
    await expect(win(page).locator(".ma-cm-collapsed-text").first()).toHaveText("4 unchanged lines");
    await expect(win(page).locator(".ma-rs-bar")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a comment goes from the chip through the composer and Send to the agent's terminal", async ({ page }) => {
    const errors = await openReview(page);
    await chip(page).click();
    const composer = win(page).locator("[data-composer]");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveAttribute("placeholder", "Leave a comment…");
    await expect(composer).toHaveValue("Round this to one decimal, like the rest of the table.");
    await win(page).locator("[data-add]").click();

    await expect(card(page)).toContainText("You · L8");
    await expect(win(page).locator(".ma-rs-count")).toHaveText("1 comment");
    await expect(win(page).locator(".ma-sc-review-where")).toHaveText("TideRow.tsx:8");
    await win(page).locator(".ma-rs-bar [data-send]").click();

    // What sendPromptToAgent and useReviewSend do: delivered, the drafts gone, the agent's pane focused.
    await expect(terminal(page)).toContainText("I left 1 comment on the current diff.");
    await expect(terminal(page)).toContainText("[1] src/tides/TideRow.tsx L8 —");
    await expect(win(page).locator(".ma-toast-message")).toHaveText("Sent 1 comment to Tide heights");
    await expect(card(page)).toHaveCount(0);
    await expect(win(page).locator(".ma-rs-bar")).toHaveCount(0);
    await expect(win(page).locator(".ma-sc-review")).toHaveCount(0);
    await expect(win(page).locator(".ma-tab-title")).toHaveText("Tide heights");
    await expect(win(page).locator(".ma-workspace-active .ma-spinner-thinking")).toBeVisible();

    await expect(terminal(page)).toContainText("Rounded feet to one decimal.", { timeout: 5000 });
    await expect(win(page).locator(".ma-workspace-active .ma-spinner")).toHaveCount(0);
    await expect(win(page).locator('[data-line="8"]')).toContainText("toFixed");
    expect(errors).toEqual([]);
  });

  test("hovering another changed line moves the chip, and the visitor's own words go as written", async ({ page }) => {
    await openReview(page);
    await win(page).locator('[data-line="9"]').hover();
    await expect(win(page).locator('[data-line="9"] .ma-cm-chip')).toBeVisible();
    await chip(page).click();
    const composer = win(page).locator("[data-composer]");
    await composer.fill("  ");
    await expect(win(page).locator("[data-add]")).toBeDisabled();
    await composer.fill("Why feet here?");
    await composer.press("Control+Enter");
    await expect(card(page)).toContainText("Why feet here?");
    await win(page).locator(".ma-rs-bar [data-send]").click();
    await expect(terminal(page)).toContainText("Why feet here?");
    await expect(terminal(page)).toContainText("Took your comment on L9", { timeout: 5000 });
    await expect(win(page).locator('[data-line="8"]')).not.toContainText("toFixed");
  });

  test("Cancel and Esc drop the composer; Edit, Delete and Discard work on a card", async ({ page }) => {
    await openReview(page);
    await chip(page).click();
    await win(page).locator("[data-cancel]").click();
    await expect(win(page).locator("[data-composer]")).toHaveCount(0);

    await win(page).locator('[data-line="8"]').click();
    await chip(page).click();
    await win(page).locator("[data-composer]").press("Escape");
    await expect(win(page).locator("[data-composer]")).toHaveCount(0);

    await win(page).locator('[data-line="8"]').hover();
    await chip(page).click();
    await win(page).locator("[data-add]").click();
    await card(page).hover();
    await card(page).getByRole("button", { name: "Edit comment" }).click();
    await win(page).locator("[data-composer]").fill("Changed my mind");
    await win(page).locator("[data-add]").click();
    await expect(card(page)).toContainText("Changed my mind");
    await card(page).hover();
    await card(page).getByRole("button", { name: "Delete comment" }).click();
    await expect(card(page)).toHaveCount(0);
    await expect(win(page).locator(".ma-rs-bar")).toHaveCount(0);

    await win(page).locator('[data-line="8"]').hover();
    await chip(page).click();
    await win(page).locator("[data-add]").click();
    const discard = win(page).locator("[data-discard]");
    await discard.click();
    await expect(discard).toHaveText("Discard 1 comment?");
    await expect(card(page)).toHaveCount(1);
    await discard.click();
    await expect(card(page)).toHaveCount(0);
  });

  test("two comments count up and go together, and leaving resets the slide", async ({ page }) => {
    await openReview(page);
    await chip(page).click();
    await win(page).locator("[data-add]").click();
    await win(page).locator('[data-line="9"]').hover();
    await chip(page).click();
    await win(page).locator("[data-add]").click();
    await expect(win(page).locator(".ma-rs-count")).toHaveText("2 comments");

    await tabs(page).first().click();
    await page.locator("#slide-tab-review").click();
    await expect(card(page)).toHaveCount(0);
    await expect(chip(page)).toBeVisible();
  });
});

test.describe("the Pull requests slide", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const win = (page: Page) => page.locator(".slideshow .mapp");
  const prCard = (page: Page) => win(page).locator("[data-pr-card]");
  const badge = (page: Page) => win(page).locator("[data-pr-badge]");
  const merge = (page: Page) => win(page).locator("[data-pr-merge]");
  const split = (page: Page) => win(page).locator("[data-pr-split]");

  async function openPrs(page: Page) {
    const errors = await open(page);
    await page.locator("#slide-tab-pull-requests").click();
    await windowOnScreen(page);
    return errors;
  }

  async function toReady(page: Page) {
    await win(page).locator("[data-pr-fix]").click();
    await expect(split(page)).toHaveClass(/ma-pr-inviting/, { timeout: 8000 });
  }

  test("it opens on the failing card: Fix checks live, merge disabled with its reason", async ({ page }) => {
    const errors = await openPrs(page);
    await expect(badge(page)).toHaveAttribute("data-readiness", "blocked");
    await expect(prCard(page)).toContainText("1 failing, 2 passing");
    await expect(prCard(page)).toContainText("+40");
    await expect(prCard(page)).toContainText("\u22123");
    await expect(win(page).locator("[data-pr-fix]")).toBeEnabled();
    await expect(merge(page)).toBeDisabled();
    await expect(merge(page)).toHaveText("Squash and merge");
    await expect(prCard(page)).toContainText("Fix the failing checks first");
    await expect(win(page).locator(".ma-pr-caret")).toHaveCount(0);
    await expect(win(page).locator("[data-pr-tick]")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("Fix checks briefs the agent and shuts the card, which comes back when the checks are green", async ({ page }) => {
    const errors = await openPrs(page);
    await win(page).locator("[data-pr-fix]").click();
    await expect(win(page).locator("[data-pr-fix]")).toBeDisabled();
    await expect(win(page).locator(".ma-toast-message")).toHaveText("Sent the failing checks to Tide heights");
    await expect(prCard(page)).toHaveCount(0);
    await expect(win(page).locator(".ma-term")).toContainText("1 check failing on PR #214");
    await expect(win(page).locator(".ma-term")).toContainText("Find the cause of each failure");

    await expect(badge(page)).toHaveAttribute("data-readiness", "pending", { timeout: 5000 });
    await badge(page).hover();
    await expect(prCard(page)).toContainText("passing", { timeout: 2000 });
    await expect(prCard(page)).toContainText("Waiting on checks or review, and this repo has no auto-merge");
    await page.mouse.move(5, 5);

    await expect(badge(page)).toHaveAttribute("data-readiness", "ready", { timeout: 5000 });
    await expect(prCard(page)).toContainText("3/3 passing");
    await expect(split(page)).toHaveClass(/ma-pr-inviting/);
    await expect(merge(page)).toBeEnabled();
    await expect(win(page).locator("[data-pr-tick]")).toHaveText("Delete workspace after merge");
    await expect(win(page).locator("[data-pr-tick] [role=checkbox]")).toHaveAttribute("aria-checked", "false");
    await expect(prCard(page).locator(".ma-pr-reason")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("Squash and merge fills through Merging… to Merged with a burst, and the card settles merged", async ({ page }) => {
    const errors = await openPrs(page);
    await toReady(page);
    await merge(page).click();
    await expect(merge(page)).toHaveText("Merging…");
    await expect(merge(page)).toBeDisabled();
    await expect(split(page)).toHaveClass(/ma-pr-filling/);
    await expect(win(page).locator("[data-pr-tick]")).toHaveCount(0);
    await expect.poll(() => merge(page).evaluate((b) => Number((b as HTMLElement).style.getPropertyValue("--merge-fill")))).toBeGreaterThan(0.3);

    await expect(merge(page)).toHaveText("Merged");
    await expect(win(page).locator(".ma-pr-burst i")).toHaveCount(26);
    await expect(win(page).locator("[data-pr-state]")).toHaveText("Merged");
    await expect(win(page).locator(".ma-toast-message")).toHaveText("Merged #214");
    // The badge waits for the poll that follows the hold.
    await expect(badge(page)).toHaveAttribute("data-readiness", "ready");

    await expect(badge(page)).toHaveAttribute("data-readiness", "merged", { timeout: 3000 });
    await expect(win(page).locator(".ma-pr-footer")).toHaveCount(0);
    await expect(win(page).locator("[data-pr-state]")).toHaveText("Merged");
    await expect(win(page).locator('[data-ws="tide-tables"]')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("leaving resets it, and what it left pending never lands", async ({ page }) => {
    await openPrs(page);
    await win(page).locator("[data-pr-fix]").click();
    await tabs(page).first().click();
    await page.locator("#slide-tab-pull-requests").click();
    await expect(badge(page)).toHaveAttribute("data-readiness", "blocked");
    await expect(prCard(page)).toContainText("1 failing, 2 passing");
    await page.waitForTimeout(1200);
    await expect(prCard(page)).toBeVisible();
    await expect(win(page).locator(".ma-term")).not.toContainText("1 check failing");
  });

  test("under reduced motion the flow still runs, with no glint, glow, fill or flecks", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openPrs(page);
    await toReady(page);
    await expect(split(page)).toHaveCSS("animation-name", "none");
    expect(await merge(page).evaluate((b) => getComputedStyle(b, "::after").display)).toBe("none");
    expect(await merge(page).evaluate((b) => getComputedStyle(b, "::before").display)).toBe("none");
    await merge(page).click();
    await expect(merge(page)).toHaveText("Merged");
    await expect(win(page).locator(".ma-pr-burst i")).toHaveCount(0);
    await expect(split(page)).toHaveCSS("animation-name", "none");
    await expect(badge(page)).toHaveAttribute("data-readiness", "merged", { timeout: 3000 });
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

  test("with more tabs than fit, moving between them really scrolls the row", async ({ page }) => {
    await open(page);
    await page.addStyleTag({ content: ".slideshow-tab { min-width: 300px; }" });
    const row = page.locator('.slideshow [role="tablist"]');
    await tabs(page).first().focus();
    await page.keyboard.press("End");
    await expect.poll(() => row.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.keyboard.press("Home");
    await expect.poll(() => row.evaluate((el) => el.scrollLeft)).toBe(0);
  });

  test("the Review and Pull requests windows fit without sideways scroll, and their flows run", async ({ page }) => {
    const errors = await open(page);
    await page.locator("#slide-tab-review").click();
    await page.locator(".ma-cm-chip").click();
    await page.locator("[data-add]").click();
    await expect(page.locator(".ma-rs-bar")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.locator("#slide-tab-pull-requests").click();
    await page.locator("[data-pr-fix]").click();
    await expect(page.locator(".ma-toast")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    expect(errors).toEqual([]);
  });

  test("the Themes window fits without sideways scroll, and its list opens", async ({ page }) => {
    const errors = await open(page);
    await page.locator("#slide-tab-themes").click();
    await page.locator("[data-theme-trigger]").click();
    await expect(page.locator(".ma-select-search")).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    expect(errors).toEqual([]);
  });
});
