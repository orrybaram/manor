import type { ComponentType } from "react";

type RootModule = { default: ComponentType };

/**
 * The root component a window renders, as a loader for `React.lazy`.
 *
 * A detached popout (ADR-156) and the primary window share very little: the
 * popout hosts one handed-off tab, the primary window everything else. Each
 * root is a separate dynamic import so each window loads only its own chunk
 * graph, and a popout never parses the primary window's sidebar, status bar
 * and modals.
 */
export function rootLoaderFor(detached: boolean): () => Promise<RootModule> {
  return detached ? () => import("../DetachedApp") : () => import("../App");
}
