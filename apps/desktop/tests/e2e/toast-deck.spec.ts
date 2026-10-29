import fs from "node:fs";
import path from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { expect, importSeededProject, test } from "./fixtures";

/**
 * The toast deck, in the real app. Toasts are raised straight through the
 * renderer's own `toast` module: the renderer is served by a Vite dev server
 * for this spec, so the page can `import()` the very module instance the app
 * uses — nothing extra ships in production for the test to reach.
 */

const appRoot = path.join(__dirname, "../..");
const PORT = 5287;
const DEV_URL = `http://localhost:${PORT}/`;

let server: ViteDevServer | undefined;

test.beforeAll(async () => {
  const { createServer } = await import("vite");
  const pkg = JSON.parse(
    fs.readFileSync(path.join(appRoot, "package.json"), "utf8"),
  ) as {
    version: string;
  };
  // No React plugin: its Fast Refresh preamble is an inline script, which
  // the page's CSP refuses. esbuild's automatic JSX runtime is enough.
  server = await createServer({
    configFile: false,
    root: appRoot,
    logLevel: "warn",
    clearScreen: false,
    server: { port: PORT, strictPort: true, hmr: false },
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    esbuild: { jsx: "automatic" },
  });
  await server.listen();
});

test.afterAll(async () => {
  await server?.close();
});

test.use({ appLaunch: { env: { VITE_DEV_SERVER_URL: DEV_URL } } });

/** Where evidence screenshots land: `MANOR_E2E_SHOTS`, or the test's output dir. */
function shot(testInfo: TestInfo, name: string): string {
  return path.join(
    process.env.MANOR_E2E_SHOTS ?? testInfo.outputPath(),
    `${name}.png`,
  );
}

/** The bottom-right corner, where the deck lives. */
async function corner(
  window: Page,
  testInfo: TestInfo,
  name: string,
  height = 460,
): Promise<void> {
  const size = await window.evaluate(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));
  const width = 560;
  await window.screenshot({
    path: shot(testInfo, name),
    clip: { x: size.w - width, y: size.h - height, width, height },
  });
}

const LIGHT_THEME = "E2E Light";

function installLightTheme(tempHome: string): void {
  const dir = path.join(
    tempHome,
    "Library",
    "Application Support",
    "ghostty",
    "themes",
  );
  fs.mkdirSync(dir, { recursive: true });
  const palette = [
    "#24292f",
    "#cf222e",
    "#116329",
    "#4d2d00",
    "#0969da",
    "#8250df",
    "#1b7c83",
    "#6e7781",
    "#57606a",
    "#a40e26",
    "#1a7f37",
    "#633c01",
    "#218bff",
    "#a475f9",
    "#3192aa",
    "#8c959f",
  ];
  fs.writeFileSync(
    path.join(dir, LIGHT_THEME),
    [
      ...palette.map((c, i) => `palette = ${i}=${c}`),
      "background = #ffffff",
      "foreground = #1f2328",
      "cursor-color = #0969da",
      "selection-background = #dbe9f9",
      "selection-foreground = #1f2328",
      "",
    ].join("\n"),
  );
}

async function useLightTheme(window: Page): Promise<void> {
  await window.evaluate(
    (name) => window.electronAPI.theme.setSelected(name),
    LIGHT_THEME,
  );
  await expect
    .poll(
      () =>
        window.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue("--bg")
            .trim(),
        ),
      {
        timeout: 10_000,
      },
    )
    .toBe("#ffffff");
}

/** Raise one toast of each kind through the app's own toast module, oldest first. */
async function raiseToasts(window: Page): Promise<void> {
  await window.evaluate(async () => {
    const { toast } = (await import(
      /* @vite-ignore */ "/src/toast/index.ts"
    )) as typeof import("../../src/toast");
    toast.info("Dashboard agents can't be resumed", {
      id: "e2e-info",
      duration: "sticky",
    });
    toast.success("Pushed fix-login-redirect", {
      id: "e2e-success",
      detail: "3 commits to origin/fix-login-redirect",
      duration: "sticky",
    });
    toast.progress("Creating worktree…", {
      id: "e2e-progress",
      detail: "fix-login-redirect",
    });
    toast.error("Push failed", {
      id: "e2e-error",
      detail:
        "! [rejected] fix-login-redirect -> fix-login-redirect (non-fast-forward)\nerror: failed to push some refs to 'github.com:acme/app.git'\nhint: Updates were rejected because the tip of your current branch is behind",
      duration: "sticky",
      action: { label: "Retry", onClick: () => {} },
    });
    toast.success("Manor 0.23.0 ready to install", {
      id: "e2e-update",
      duration: "sticky",
      action: { label: "Restart now", onClick: () => {} },
      secondaryAction: { label: "Later", onClick: () => {} },
    });
    toast.progress("Agent needs input", {
      id: "e2e-attention",
      detail: "fix-login-redirect · claude",
      duration: "sticky",
      action: { label: "Go to agent", onClick: () => {} },
    });
  });
}

async function dismissToasts(window: Page): Promise<void> {
  await window.evaluate(async () => {
    const { toast } = (await import(
      /* @vite-ignore */ "/src/toast/index.ts"
    )) as typeof import("../../src/toast");
    for (const id of [
      "e2e-info",
      "e2e-success",
      "e2e-progress",
      "e2e-error",
      "e2e-update",
      "e2e-attention",
    ]) {
      toast.dismiss(id);
    }
  });
}

/** Rest the pointer far from the deck, so it collapses. */
async function moveAway(window: Page): Promise<void> {
  await window.mouse.move(40, 200);
  await expect(window.getByTestId("toast-deck")).toHaveAttribute(
    "data-fanned",
    "false",
  );
}

async function walkTheDeck(
  window: Page,
  testInfo: TestInfo,
  theme: string,
): Promise<void> {
  const deck = window.getByTestId("toast-deck");
  const cards = deck.getByTestId("toast");

  await raiseToasts(window);
  await expect(cards).toHaveCount(6);
  await moveAway(window);
  await window.waitForTimeout(400);

  // Collapsed: only the front (newest) card takes input, and the deck's hit
  // area is the front card plus three 10px peeks — not a column of six.
  const front = cards.last();
  await expect(front).toContainText("Agent needs input");
  await expect(front).not.toHaveAttribute("inert");
  await expect(cards.first()).toHaveAttribute("inert");
  const frontBox = (await front.boundingBox())!;
  const collapsedBox = (await deck.boundingBox())!;
  expect(collapsedBox.height).toBeLessThan(frontBox.height + 3 * 10 + 4);
  await corner(window, testInfo, `deck-collapsed-${theme}`);

  // Hover fans it out into a column, every card interactive.
  await window.mouse.move(
    frontBox.x + frontBox.width / 2,
    frontBox.y + frontBox.height / 2,
  );
  await expect(deck).toHaveAttribute("data-fanned", "true");
  await window.waitForTimeout(400);
  const fannedBox = (await deck.boundingBox())!;
  expect(fannedBox.height).toBeGreaterThan(6 * frontBox.height);
  await expect(cards.first()).not.toHaveAttribute("inert");
  await corner(window, testInfo, `deck-fanned-${theme}`, 520);

  // The error's detail expands in place; the column makes room for it.
  const error = cards.filter({ hasText: "Push failed" });
  await error.getByRole("button", { expanded: false }).click();
  await expect(error.getByRole("button", { expanded: true })).toBeVisible();
  await window.waitForTimeout(400);
  const grownBox = (await deck.boundingBox())!;
  expect(grownBox.height).toBeGreaterThan(fannedBox.height + 20);
  await corner(window, testInfo, `deck-detail-expanded-${theme}`, 620);

  // Away from it, it collapses again; keyboard focus fans it out too.
  // (A click focuses a button too; only keyboard focus holds the fan.)
  await moveAway(window);
  await window.keyboard.press("Shift");
  await front.getByRole("button", { name: "Go to agent" }).focus();
  await expect(deck).toHaveAttribute("data-fanned", "true");
  await front.getByRole("button", { name: "Go to agent" }).blur();
  await expect(deck).toHaveAttribute("data-fanned", "false");

  // One toast alone is just a card.
  await dismissToasts(window);
  await expect(deck).toHaveCount(0);
  await window.evaluate(async () => {
    const { toast } = (await import(
      /* @vite-ignore */ "/src/toast/index.ts"
    )) as typeof import("../../src/toast");
    toast.success('Copied "fix-login-redirect"', {
      id: "e2e-single",
      duration: "sticky",
    });
  });
  await expect(cards).toHaveCount(1);
  await window.waitForTimeout(400);
  await corner(window, testInfo, `deck-single-${theme}`, 200);
  await window.evaluate(async () => {
    const { toast } = (await import(
      /* @vite-ignore */ "/src/toast/index.ts"
    )) as typeof import("../../src/toast");
    toast.dismiss("e2e-single");
  });
  await expect(deck).toHaveCount(0);

  // Secondary Buttons on a dialog's surface carry a visible outline.
  await window.keyboard.press("ControlOrMeta+Shift+n");
  const dialog = window.locator('[data-testid="new-workspace-dialog"]');
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  const outline = await cancel.evaluate(
    (el) => getComputedStyle(el).borderTopColor,
  );
  const surface = await window.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--surface")
      .trim(),
  );
  expect(outline).not.toBe(surface);
  await window.waitForTimeout(300);
  await dialog.screenshot({
    path: shot(testInfo, `dialog-secondary-buttons-${theme}`),
  });
  await window.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
}

test("toasts stack into a deck that fans out on hover, outlined controls in dark and light", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  installLightTheme(tempHome);
  await importSeededProject(app, window, tempHome);

  await walkTheDeck(window, testInfo, "dark");
  await useLightTheme(window);
  await walkTheDeck(window, testInfo, "light");
});
