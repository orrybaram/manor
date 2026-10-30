import { expect, test } from "./fixtures";

/**
 * The app window never leaves the app. Its preload hands the page the whole
 * bridge, so a page the window was sent to — by a dropped link or file, or
 * any script — would get terminals.
 */
test("the app window refuses to navigate to another page", async ({ window }) => {
  const appUrl = window.url();
  for (const target of ["file:///etc/hostname", "https://example.com/"]) {
    await window.evaluate((url) => {
      window.location.href = url;
    }, target);
    await window.waitForTimeout(500);
    expect(window.url()).toBe(appUrl);
    expect(await window.evaluate(() => typeof (window as { manorHost?: unknown }).manorHost)).toBe(
      "object",
    );
  }
  await window.screenshot({ path: "test-results/window-navigation.png" });
});
