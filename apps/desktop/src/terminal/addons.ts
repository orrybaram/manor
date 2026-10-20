/**
 * The xterm add-ons beyond the core terminal, loaded when a terminal needs
 * them rather than with the app. Together they are a couple of hundred
 * kilobytes the shell can paint without:
 *
 * - WebGL, image and Unicode 11 change how the grid is drawn and measured, so
 *   they load before a terminal is created (`whenTerminalCanOpen`).
 * - Search loads when a pane's search bar first opens.
 * - Serialize loads when something first asks a pane for a snapshot.
 *
 * Each loader runs its import once; every caller after that shares the result.
 */

import type { Terminal } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";
import { loadOnce } from "../lib/load-once";
import { terminalFontsReady } from "../lib/terminal-font";
import { isWebApp } from "../lib/platform";
import { currentLayoutMode } from "../hooks/useLayoutMode";

/**
 * Import an add-on the terminal can open without. A chunk that fails to load
 * costs that add-on — the DOM renderer, no inline images, the default Unicode
 * widths — not the pane.
 */
function optional<T>(name: string, load: () => Promise<T>): Promise<T | null> {
  return load().catch((err: unknown) => {
    console.warn(`Terminal ${name} add-on failed to load`, err);
    return null;
  });
}

const loadWebgl = loadOnce(() =>
  import("@xterm/addon-webgl").then((m) => m.WebglAddon),
);
const loadImage = loadOnce(() =>
  import("@xterm/addon-image").then((m) => m.ImageAddon),
);
const loadUnicode11 = loadOnce(() =>
  import("@xterm/addon-unicode11").then((m) => m.Unicode11Addon),
);

/**
 * A phone browser draws with xterm's DOM renderer. Every workspace's panes
 * stay mounted (so a switch resizes nothing), and with WebGL each of them
 * holds a context and a glyph atlas: on a phone that is most of the cold
 * load's CPU, memory a phone does not have, and more contexts than mobile
 * browsers keep alive at once. One small grid on screen at a time is what
 * the DOM renderer is good at.
 */
function wantsWebgl(): boolean {
  return !(isWebApp() && currentLayoutMode() === "phone");
}

async function loadRenderAddons() {
  const [WebglAddon, ImageAddon, Unicode11Addon] = await Promise.all([
    wantsWebgl() ? optional("WebGL", loadWebgl) : null,
    optional("image", loadImage),
    optional("Unicode 11", loadUnicode11),
  ]);
  return { WebglAddon, ImageAddon, Unicode11Addon };
}

/** Each is `null` when its chunk failed to load; the terminal opens without it. */
export type RenderAddons = Awaited<ReturnType<typeof loadRenderAddons>>;

/**
 * Everything a terminal needs in hand before it is created: the add-ons that
 * decide how its grid is drawn, and the fonts its cell is measured from (see
 * `lib/terminal-font`). Creating it any earlier measures the wrong cell.
 */
export async function whenTerminalCanOpen(): Promise<RenderAddons> {
  const [addons] = await Promise.all([loadRenderAddons(), terminalFontsReady()]);
  return addons;
}

export const loadSearchAddon = loadOnce(() =>
  import("@xterm/addon-search").then((m) => m.SearchAddon),
);

const searchAddons = new WeakMap<Terminal, Promise<SearchAddon | null>>();

/**
 * The terminal's search add-on, loaded onto it the first time it is asked for
 * and kept for the terminal's life (it is disposed with the terminal, like
 * every add-on loaded onto it). The promise is stable per terminal, so a
 * component can `use()` it — which is also why a failure is kept rather than
 * retried: a fresh promise on every render would suspend forever. `null` when
 * the chunk failed to load; a terminal created after that tries again.
 */
export function searchAddonFor(term: Terminal): Promise<SearchAddon | null> {
  let pending = searchAddons.get(term);
  if (!pending) {
    pending = loadSearchAddon().then(
      (SearchAddonCtor) => {
        const addon = new SearchAddonCtor();
        term.loadAddon(addon);
        return addon;
      },
      (err: unknown) => {
        console.warn("Terminal search failed to load", err);
        return null;
      },
    );
    searchAddons.set(term, pending);
  }
  return pending;
}

export const loadSerializeAddon = loadOnce(() =>
  import("@xterm/addon-serialize").then((m) => m.SerializeAddon),
);
