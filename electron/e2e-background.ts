// electron/e2e-background.ts — keep an E2E-launched app out of the user's way
import { app, type BrowserWindow } from "electron";

/**
 * TEST-ONLY: set by the E2E fixtures (tests/e2e/fixtures.ts), never by a real
 * launch, and ignored in a packaged build.
 *
 * A suite launches the app dozens of times. Left alone, every launch puts its
 * window in front of whatever the person is doing and takes keyboard focus.
 * In background mode the app has no Dock icon, so macOS never makes it the
 * active app, and its windows never take focus. macOS has no way to open a
 * window *behind* another app's, so an unfocused window still lands on top;
 * instead it is fully transparent and lets clicks fall through to whatever is
 * under it.
 *
 * Playwright drives the renderer over CDP — input, screenshots and video all
 * go through the page, not the screen — so it needs neither focus nor a
 * visible window. What it does need is a renderer that keeps painting, which
 * Chromium otherwise throttles for windows it thinks nobody can see.
 */
export const e2eBackground =
  !app.isPackaged && process.env.MANOR_E2E_BACKGROUND === "1";

/** Call before `ready`: the switches only apply to a browser not yet started. */
export function applyE2eBackgroundSwitches(): void {
  if (!e2eBackground) return;
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.dock?.hide();
}

/** `BrowserWindow` options for a window that should not take the screen. */
export function e2eWindowOptions(): Electron.BrowserWindowConstructorOptions {
  return e2eBackground ? { show: false, opacity: 0, hasShadow: false } : {};
}

/** Show a window created with `e2eWindowOptions` without bringing it forward. */
export function showE2eWindow(win: BrowserWindow): void {
  if (!e2eBackground) return;
  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    win.setIgnoreMouseEvents(true);
    win.showInactive();
  });
}
