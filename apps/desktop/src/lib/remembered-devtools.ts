/**
 * A browser pane's docked DevTools, remembered across the pane's remounts.
 *
 * Moving a pane (to another split, another panel) rebuilds the pane tree, so
 * its `BrowserPane` and `<webview>` mount afresh with a new page, and main
 * closes the old page's DevTools when it unregisters. What the pane had open,
 * and where, is kept here by pane id so the new mount can reopen them the
 * same way once its page registers.
 *
 * In memory only, for this renderer's life: nothing here reaches disk. An
 * entry goes when the user closes DevTools and when the pane itself is
 * closed (the store forgets panes that leave the layout), so a pane reopened
 * later under the same id starts without them.
 */
import type { DevToolsDockSide } from "./devtools-dock";

export interface RememberedDevTools {
  side: DevToolsDockSide;
  /** DevTools' share of the pane on each side; each side keeps its own. */
  fractions: Record<DevToolsDockSide, number>;
}

const remembered = new Map<string, RememberedDevTools>();

/** `paneId` has DevTools open, docked as `dock`. */
export function rememberDevTools(paneId: string, dock: RememberedDevTools): void {
  remembered.set(paneId, { side: dock.side, fractions: { ...dock.fractions } });
}

/** The DevTools `paneId` had open when it last mounted, if they still are. */
export function rememberedDevTools(paneId: string): RememberedDevTools | undefined {
  const dock = remembered.get(paneId);
  return dock && { side: dock.side, fractions: { ...dock.fractions } };
}

/** `paneId`'s DevTools were closed, or the pane was. */
export function forgetDevTools(paneId: string): void {
  remembered.delete(paneId);
}
