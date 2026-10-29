import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { expect, test } from "../fixtures";

const appRoot = path.join(__dirname, "../../..");

/**
 * Serve this spec's renderer from source, through its own Vite dev server.
 *
 * The page can then `import("/src/...")` the very module instances the app
 * runs — the toast module, the agent store, main's view of window focus — so
 * a spec drives or observes them directly, and nothing extra ships in
 * production for a test to reach. Call once at the top of a spec file.
 *
 * Each worker gets its own server on a free port, with its own throwaway
 * cache: parallel workers and other runs on the machine never collide, and
 * `pnpm dev`'s `.vite` cache is left alone.
 */
export function serveRendererFromSource(): void {
  let server: ViteDevServer | undefined;
  let cacheDir: string | undefined;
  let url: string | undefined;

  test.beforeAll(async () => {
    const { createServer } = await import("vite");
    const pkg = JSON.parse(
      fs.readFileSync(path.join(appRoot, "package.json"), "utf8"),
    ) as { version: string };
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-e2e-vite-"));
    // No React plugin: its Fast Refresh preamble is an inline script, which
    // the page's CSP refuses. esbuild's automatic JSX runtime is enough.
    server = await createServer({
      configFile: false,
      root: appRoot,
      cacheDir,
      logLevel: "warn",
      clearScreen: false,
      server: { port: 0, host: "localhost", hmr: false },
      define: { __APP_VERSION__: JSON.stringify(pkg.version) },
      esbuild: { jsx: "automatic" },
    });
    await server.listen();
    url = server.resolvedUrls?.local[0];
    if (!url) throw new Error("Vite dev server reported no local URL");
  });

  test.afterAll(async () => {
    await server?.close();
    if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  // A fixture, not a value: the URL exists only once beforeAll has run.
  test.use({
    // eslint-disable-next-line no-empty-pattern
    appLaunch: async ({}, use) => {
      if (!url) throw new Error("renderer dev server is not running");
      await use({ env: { VITE_DEV_SERVER_URL: url } });
    },
  });
}

/**
 * Make main see the app's window as focused for the rest of the test, and wait
 * until the renderer's own focus signal (`src/lib/window-focus.ts`) agrees.
 *
 * The toasts care: agent toasts are raised only in the focused window, and
 * countdowns hold while it is unfocused. An E2E launch never takes focus
 * (electron/e2e-background.ts), and real focus will not do either: there is
 * one per machine, and parallel workers' windows take it from each other
 * mid-test. So main's view is pinned instead — `isFocused()` answers true and
 * every `window:focus-changed` push says focused. Needs
 * `serveRendererFromSource`.
 */
export async function focusWindow(
  app: ElectronApplication,
  window: Page,
): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const contents = win.webContents;
    const send = contents.send.bind(contents);
    win.isFocused = () => true;
    contents.send = (channel: string, ...args: unknown[]) =>
      channel === "window:focus-changed"
        ? send(channel, true)
        : send(channel, ...args);
    send("window:focus-changed", true);
  });
  await expect
    .poll(() =>
      window.evaluate(async () => {
        const { isWindowFocused } = (await import(
          /* @vite-ignore */ "/src/lib/window-focus.ts"
        )) as typeof import("../../../src/lib/window-focus");
        return isWindowFocused();
      }),
    )
    .toBe(true);
}
