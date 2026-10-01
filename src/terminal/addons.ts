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

import { terminalFontsReady } from "../lib/terminal-font";

function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().catch((err: unknown) => {
      // A failed chunk load is retried by the next caller, not cached.
      pending = null;
      throw err;
    });
    return pending;
  };
}

const loadRenderAddons = once(async () => {
  const [webgl, image, unicode11] = await Promise.all([
    import("@xterm/addon-webgl"),
    import("@xterm/addon-image"),
    import("@xterm/addon-unicode11"),
  ]);
  return {
    WebglAddon: webgl.WebglAddon,
    ImageAddon: image.ImageAddon,
    Unicode11Addon: unicode11.Unicode11Addon,
  };
});

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

export const loadSearchAddon = once(() =>
  import("@xterm/addon-search").then((m) => m.SearchAddon),
);

export const loadSerializeAddon = once(() =>
  import("@xterm/addon-serialize").then((m) => m.SerializeAddon),
);
