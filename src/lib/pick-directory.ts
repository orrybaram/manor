/**
 * The native directory picker, or an honest "nothing picked" in a browser.
 *
 * `dialog` is a namespace no browser has (`src/bridge/unavailable.ts`,
 * ADR-180 D8): the picker is this machine's, and a tab on another one has no
 * filesystem to show. Every "choose a folder" flow goes through here so the
 * web app answers it the same way — one toast saying where to do it, and
 * `null`, which each caller already handles as a cancelled pick — instead of
 * an unhandled `unavailable:web` rejection.
 */

import { isWebApp } from "./platform";
import { showBridgeUnavailableToastOnce } from "./bridge-unavailable-toast";

export async function pickDirectory(): Promise<string | null> {
  if (isWebApp()) {
    showBridgeUnavailableToastOnce(
      "pick-directory",
      "Choosing a folder needs the desktop app",
    );
    return null;
  }
  return window.electronAPI.dialog.openDirectory();
}
