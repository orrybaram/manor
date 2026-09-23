/**
 * `/panes`, `/tabs`, and `/workspaces` (ADR-149, ADR-171) — layout inspection
 * and mutation, split two ways (ADR-179 D5):
 *
 * - **Structural** routes (`./panes-structural.ts`) — split, close, move,
 *   pin, reorder, new tab, reopen — call `LayoutStore.apply()` directly and
 *   need no window.
 * - **Viewport** routes (`./panes-viewport.ts`) — focus, select, next/prev
 *   tab, set the active workspace — proxy to the primary window, because a
 *   viewport is per renderer (D3).
 *
 * Body validation is `./pane-validators.ts`.
 */

import type { Route } from "./types";
import { structuralRoutes } from "./panes-structural";
import { viewportRoutes } from "./panes-viewport";

export const paneRoutes: Route[] = [...structuralRoutes, ...viewportRoutes];
