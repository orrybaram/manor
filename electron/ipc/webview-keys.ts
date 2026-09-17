/**
 * Key handling for a focused web page (a `<webview>` guest). Keys pressed in a
 * page never reach the host renderer's `keydown` listener, so main inspects
 * them in `before-input-event` instead (ADR-074, widened by ADR-175):
 *
 * - Escape twice within 500ms hands the keyboard back to the app.
 * - The browser's own commands (zoom, reload, URL bar, find, back/forward) run
 *   against the page.
 * - Any other combo bound in the keybinding map — F6 included — is forwarded
 *   to the host renderer, which runs it like a local key press.
 * - Everything else stays with the page.
 *
 * Electron is only imported for types, so this module can be unit tested.
 */

import {
  resolvePageKey,
  type KeyCombo,
} from "../../src/lib/keybinding-defs";
import type { ForwardedCommandPayload } from "../../src/lib/menu-commands";

/** The subset of the guest's `WebContents` the handler drives. */
export interface PageWebContents {
  getZoomLevel(): number;
  setZoomLevel(level: number): void;
  reload(): void;
}

/** The subset of the host renderer's `WebContents` the handler talks to. */
export interface HostWebContents {
  send(channel: string, ...args: unknown[]): void;
  isDestroyed?(): boolean;
}

export interface PageKeyHandlerDeps {
  paneId: string;
  page: PageWebContents;
  host: HostWebContents;
  /** The current merged keybinding map; read on every key press. */
  getBindings: () => Record<string, KeyCombo>;
  now?: () => number;
}

const DOUBLE_ESCAPE_MS = 500;
const MAX_ZOOM_LEVEL = 5;
const MIN_ZOOM_LEVEL = -3;
const ZOOM_STEP = 0.5;

/** Browser commands relayed to the host pane on their own channel. */
const RELAYED_BROWSER_COMMANDS: Record<string, string> = {
  "browser-focus-url": "webview:focus-url",
  "browser-find": "webview:find",
  "browser-back": "webview:go-back",
  "browser-forward": "webview:go-forward",
};

/** The KeyCombo an Electron `Input` describes. */
export function comboFromInput(input: Electron.Input): KeyCombo {
  return {
    key: input.key,
    meta: input.meta,
    ctrl: input.control,
    shift: input.shift,
    alt: input.alt,
  };
}

/** Build the guest's `before-input-event` listener. */
export function createPageKeyHandler(
  deps: PageKeyHandlerDeps,
): (event: Electron.Event, input: Electron.Input) => void {
  const { paneId, page, host, getBindings } = deps;
  const now = deps.now ?? Date.now;
  let lastEscapeTime = 0;

  const send = (channel: string, ...args: unknown[]) => {
    if (host.isDestroyed?.()) return;
    host.send(channel, ...args);
  };

  return (event, input) => {
    if (input.type !== "keyDown") return;

    // Escape — double-tap to blur the webview.
    if (
      input.key === "Escape" &&
      !input.alt &&
      !input.control &&
      !input.meta &&
      !input.shift
    ) {
      const time = now();
      if (time - lastEscapeTime < DOUBLE_ESCAPE_MS) {
        event.preventDefault();
        send("webview:escape", paneId);
        lastEscapeTime = 0;
      } else {
        lastEscapeTime = time;
      }
      return;
    }

    const action = resolvePageKey(comboFromInput(input), getBindings());
    if (!action) return;
    event.preventDefault();

    if (action.kind === "app") {
      const payload: ForwardedCommandPayload = {
        commandId: action.commandId,
        source: "webview",
        paneId,
      };
      send("keybinding-command", payload);
      return;
    }

    switch (action.commandId) {
      case "browser-zoom-in":
        page.setZoomLevel(
          Math.min(page.getZoomLevel() + ZOOM_STEP, MAX_ZOOM_LEVEL),
        );
        return;
      case "browser-zoom-out":
        page.setZoomLevel(
          Math.max(page.getZoomLevel() - ZOOM_STEP, MIN_ZOOM_LEVEL),
        );
        return;
      case "browser-zoom-reset":
        page.setZoomLevel(0);
        return;
      case "browser-reload":
        page.reload();
        return;
      default: {
        const channel = RELAYED_BROWSER_COMMANDS[action.commandId];
        if (channel) send(channel, paneId);
      }
    }
  };
}
