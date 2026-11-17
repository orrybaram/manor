import { type Page } from "@playwright/test";

import { expect, importSeededProject, test } from "./fixtures";

/**
 * Drag regions stand down while a popover is open (`lib/drag-regions.ts`), so
 * a title-bar click can dismiss it, without the `html:has()` rule that made
 * every DOM change restyle the whole window.
 */

const bell = (window: Page) => window.getByTestId("notifications-bell");
const popover = (window: Page) => window.getByTestId("notifications-popover");

/** Mark every element that is a drag region now; returns how many. */
function markDragRegions(window: Page): Promise<number> {
  return window.evaluate(() => {
    let n = 0;
    for (const el of document.querySelectorAll("*")) {
      if (getComputedStyle(el).getPropertyValue("-webkit-app-region") === "drag") {
        el.setAttribute("data-test-drag-region", "");
        n++;
      }
    }
    return n;
  });
}

/** `-webkit-app-region` of the marked drag regions, deduplicated. */
function dragRegionStates(window: Page): Promise<string[]> {
  return window.evaluate(() => {
    const seen = new Set<string>();
    for (const el of document.querySelectorAll("[data-test-drag-region]")) {
      seen.add(getComputedStyle(el).getPropertyValue("-webkit-app-region"));
    }
    return [...seen];
  });
}

test.describe("drag regions", () => {
  test.setTimeout(120_000);

  test("stand down while a popover is open, and come back when it closes", async ({
    app,
    window,
    tempHome,
  }) => {
    // The sidebar — and so the bell — only exists once a project does.
    await importSeededProject(app, window, tempHome);
    await expect(bell(window)).toBeVisible({ timeout: 30_000 });
    const html = window.locator("html");
    await expect(html).not.toHaveClass(/popover-open/);
    expect(await markDragRegions(window)).toBeGreaterThan(0);
    expect(await dragRegionStates(window)).toEqual(["drag"]);

    await bell(window).click();
    await expect(popover(window)).toBeVisible({ timeout: 5_000 });
    await expect(html).toHaveClass(/popover-open/);
    expect(await dragRegionStates(window)).toEqual(["no-drag"]);
    await window.screenshot({ path: test.info().outputPath("popover-open.png") });

    await window.keyboard.press("Escape");
    await expect(popover(window)).not.toBeVisible({ timeout: 5_000 });
    await expect(html).not.toHaveClass(/popover-open/);
    expect(await dragRegionStates(window)).toEqual(["drag"]);
  });

  test("a text change restyles only what changed, not the whole window", async ({
    window,
  }) => {
    await expect(window.locator("#root > *")).not.toHaveCount(0, { timeout: 30_000 });

    // What xterm's DOM renderer does per uncached glyph, under a window as
    // full as many DOM-rendered terminals make it.
    const timing = await window.evaluate(() => {
      const filler = document.createElement("div");
      filler.style.cssText = "position:absolute;visibility:hidden;left:-9999px";
      for (let r = 0; r < 600; r++) {
        const row = filler.appendChild(document.createElement("div"));
        for (let c = 0; c < 40; c++) row.appendChild(document.createElement("span")).textContent = "x";
      }
      document.body.append(filler);
      const probe = document.body.appendChild(document.createElement("span"));
      probe.style.cssText = "position:absolute;visibility:hidden";

      const measure = () => {
        const start = performance.now();
        for (let i = 0; i < 100; i++) {
          probe.textContent = String.fromCharCode(0x4e00 + i).repeat(32);
          void probe.offsetWidth;
        }
        return (performance.now() - start) / 100;
      };

      const now = measure();
      const old = document.createElement("style");
      old.textContent = `html:has([data-radix-popper-content-wrapper] [role="dialog"], [data-radix-popper-content-wrapper] [role="menu"], [data-radix-popper-content-wrapper] [role="listbox"]) * { -webkit-app-region: no-drag !important; }`;
      document.head.append(old);
      const before = measure();
      old.remove();
      filler.remove();
      probe.remove();
      return { now, before };
    });

    console.log(
      `per measure: ${timing.now.toFixed(3)} ms now, ${timing.before.toFixed(3)} ms with the old html:has() rule`,
    );
    expect(timing.now * 3).toBeLessThan(timing.before);
  });
});
