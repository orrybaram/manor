/**
 * Opening Radix `ContextMenu`s from the keyboard (ADR-175). Right-click-only
 * actions — tab close-others and duplicate, folder delete, unhide workspaces,
 * kill port, and more — otherwise live behind a `contextmenu` event macOS
 * never produces from the keyboard.
 *
 * `isContextMenuKey` is the one definition of the trigger keys, shared by
 * every row with a context menu: sidebar rows (`sidebar-row.ts`), tabs
 * (`TabButton.tsx`), sidebar agent rows (`AgentsList.tsx`) and port badges
 * (`PortBadge.tsx`).
 */

/** The subset of a keyboard event `isContextMenuKey` needs. */
type ContextMenuKeyEvent = {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
};

/**
 * Shift+F10, the ContextMenu key, or ⌘. (with no other modifiers) — the
 * combos that open a context menu from the keyboard. ⌘. alone, not ⌘⇧., so it
 * doesn't clash with Copy Branch Name (⌘⇧.).
 */
export function isContextMenuKey(e: ContextMenuKeyEvent): boolean {
  if (e.key === "ContextMenu") return true;
  if (e.key === "F10" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
    return true;
  }
  return (
    e.key === "." && e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey
  );
}

/**
 * Dispatch a synthetic `contextmenu` `MouseEvent` at `el`'s bottom-left
 * corner (offset 4px further down), the way a real right-click would. Radix's
 * `ContextMenu.Trigger` reads `clientX` / `clientY` off the event to position
 * the menu, and the DismissableLayer it opens then takes focus itself, so
 * arrow keys work inside it.
 */
export function openContextMenuFromKeyboard(el: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: rect.left,
    clientY: rect.bottom + 4,
    button: 2,
  });
  el.dispatchEvent(event);
}
