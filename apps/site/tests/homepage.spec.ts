import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * The two things on the homepage that would quietly cost downloads if they
 * broke, end to end against the production build.
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
