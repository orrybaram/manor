/**
 * Unattended mode: the app runs for a test, not for a person.
 *
 * The e2e suite launches the real app on the developer's own desktop, so every
 * run used to take over the machine — windows opening on top of whatever was
 * in front, focus and the menu bar stolen from the editor mid-keystroke, a
 * dock icon bouncing, and notification banners with sound for every agent the
 * fake harness parks in `requires_input`.
 *
 * With `--manor-unattended` the app still does all of that work, it just does
 * it where nobody has to watch: windows are created hidden (Playwright drives
 * the renderer over CDP, which never needed them on screen), the app is an
 * accessory with no dock icon so it cannot become the active app, and native
 * notifications stay quiet.
 *
 * It is a launch *argument* rather than an environment variable because the
 * e2e fixture deliberately scrubs `MANOR_*` from the app's environment.
 */
export function isUnattended(): boolean {
  return process.argv.includes("--manor-unattended");
}

/**
 * Chromium switches that keep a never-shown window working like a shown one.
 *
 * A hidden or occluded window is normally backgrounded: timers are throttled,
 * the renderer is deprioritised, and frame production stops — which would make
 * anything the tests drive through rAF (xterm's renderer, resize handling)
 * stall instead of fail, the worst kind of flake. Must run before `ready`.
 */
export function applyUnattendedSwitches(
  commandLine: Electron.CommandLine,
): void {
  commandLine.appendSwitch("disable-background-timer-throttling");
  commandLine.appendSwitch("disable-renderer-backgrounding");
  commandLine.appendSwitch("disable-backgrounding-occluded-windows");
}
