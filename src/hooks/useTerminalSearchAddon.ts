import { useEffect, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";
import { loadSearchAddon } from "../terminal/addons";

/**
 * The terminal's search add-on, loaded onto it the first time its search bar
 * opens (`wanted`) and kept for the terminal's life after that. `null` until
 * then, and for a terminal it has not been loaded onto yet.
 */
export function useTerminalSearchAddon(
  term: Terminal | null,
  wanted: boolean,
): SearchAddon | null {
  const [loaded, setLoaded] = useState<{
    term: Terminal;
    addon: SearchAddon;
  } | null>(null);
  const current = loaded?.term === term ? loaded.addon : null;

  useEffect(() => {
    if (!term || !wanted || current) return;
    let live = true;
    loadSearchAddon().then(
      (SearchAddon) => {
        if (!live) return;
        const addon = new SearchAddon();
        // Disposed with the terminal, like every add-on loaded onto it.
        term.loadAddon(addon);
        setLoaded({ term, addon });
      },
      (err: unknown) => console.warn("Terminal search failed to load", err),
    );
    return () => {
      live = false;
    };
  }, [term, wanted, current]);

  return current;
}
