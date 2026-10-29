import type { Page } from "@playwright/test";
import { bootWorkspaceWithTerminal, expect, openTerminalTab, test } from "./fixtures";

/**
 * Begin a native tab drag on `tabIndex` of the first panel and hold it over
 * (x, y). One DataTransfer rides every event, as in a real drag, and it stays
 * on `window` so `dropTabAt` can finish the same gesture.
 */
async function dragTabOver(window: Page, tabIndex: number, x: number, y: number) {
  await window.evaluate(
    ({ tabIndex }) => {
      const tab = document.querySelectorAll('[data-testid="tab"]')[tabIndex]!;
      const r = tab.getBoundingClientRect();
      const dt = new DataTransfer();
      (window as unknown as { __dt: DataTransfer }).__dt = dt;
      tab.dispatchEvent(
        new DragEvent("dragstart", {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
          clientX: r.left + 10,
          clientY: r.top + 10,
        }),
      );
    },
    { tabIndex },
  );
  // The bar reads the drag from React state, so let it render first.
  await window.waitForTimeout(100);
  await moveDragTo(window, x, y);
}

async function moveDragTo(window: Page, x: number, y: number) {
  await window.evaluate(
    ({ x, y }) => {
      const dt = (window as unknown as { __dt: DataTransfer }).__dt;
      const target = document.elementFromPoint(x, y)!;
      for (const type of ["dragenter", "dragover"]) {
        target.dispatchEvent(
          new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y }),
        );
      }
    },
    { x, y },
  );
}

async function dropTabAt(window: Page, x: number, y: number) {
  await window.evaluate(
    ({ x, y }) => {
      const dt = (window as unknown as { __dt: DataTransfer }).__dt;
      document.elementFromPoint(x, y)!.dispatchEvent(
        new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y }),
      );
    },
    { x, y },
  );
}

async function barRect(window: Page) {
  const box = await window.locator('[role="tablist"]').first().boundingBox();
  if (!box) throw new Error("no tab bar");
  return box;
}

test("dragging a tab to the empty right of its own bar splits it into a new panel", async ({
  app,
  window,
  tempHome,
}) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "tab-drag-ws");
  await openTerminalTab(window);
  await expect(window.locator('[data-testid="tab"]')).toHaveCount(2);

  const tabs = window.locator('[data-testid="tab"]');
  const second = (await tabs.nth(1).boundingBox())!;
  const bar = await barRect(window);
  const midY = second.y + second.height / 2;

  // Reorder: the insertion bar sits between the two tabs, within the tabs.
  await dragTabOver(window, 1, second.x + 4, midY);
  await window.screenshot({ path: test.info().outputPath("reorder.png") });
  // Tabs hang past the bar and are cut off by the panel body's top edge, so
  // that edge is where a tab visibly ends.
  const bodyTop = (await window.locator('[data-focus-region="pane"]').first().boundingBox())!.y;
  const insertion = (await window.locator('[class*="tabInsertionBar"]').boundingBox())!;
  expect(insertion.y).toBeGreaterThanOrEqual(second.y);
  expect(insertion.y + insertion.height).toBeLessThanOrEqual(bodyTop);

  // The highlight covers the whole tab row, down to that edge.
  const highlight = (await window.locator('[class*="tabBarDropHighlight"]').boundingBox())!;
  expect(highlight.y).toBeLessThanOrEqual(second.y);
  expect(Math.round(highlight.y + highlight.height)).toBe(Math.round(bodyTop));

  // The empty right of the bar offers a split.
  const splitX = bar.x + bar.width * 0.85;
  await moveDragTo(window, splitX, bar.y + bar.height / 2);
  await expect(window.locator('[class*="tabBarSplitHint"]')).toHaveCount(1);
  await window.screenshot({ path: test.info().outputPath("split-hint.png") });

  await dropTabAt(window, splitX, bar.y + bar.height / 2);
  await expect(window.locator('[role="tablist"]')).toHaveCount(2);
  await window.screenshot({ path: test.info().outputPath("split.png") });
});
