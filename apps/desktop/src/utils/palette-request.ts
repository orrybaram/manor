import type { PaletteView } from "../components/command-palette/types";

type Listener = (view: PaletteView) => void;

const listeners = new Set<Listener>();

/**
 * Lets code outside the React tree (notification navigation, for one) ask the
 * command palette to open on a given view. `App` owns the palette's open
 * state and subscribes once; nobody else needs the setter.
 */
export function onPaletteViewRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function requestPaletteView(view: PaletteView): void {
  for (const listener of listeners) listener(view);
}
