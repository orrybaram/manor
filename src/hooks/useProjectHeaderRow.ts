import { useCallback, useRef, type CSSProperties, type KeyboardEvent } from "react";
import { handleSidebarRowKeyDown } from "../lib/sidebar-row";
import { openContextMenuFromKeyboard } from "../lib/keyboard-context-menu";

/**
 * The behavior a collapsible project-style header row shares — a project's
 * and a linked group's (ADR-192): Enter/Space and ←/→ toggle it, the menu
 * key opens its context menu, and a menu opened from the keyboard hands
 * focus back to the row as it closes (ADR-175). A mouse-opened menu keeps
 * Radix's own default.
 */
export function useProjectHeaderRow(collapsed: boolean, onToggleCollapsed: () => void) {
  const headerRef = useRef<HTMLDivElement | null>(null);
  const menuOpenedByKeyboard = useRef(false);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) =>
      handleSidebarRowKeyDown(e, {
        activate: onToggleCollapsed,
        setExpanded: (next) => {
          if (next === collapsed) onToggleCollapsed();
        },
        openMenu: (row) => {
          menuOpenedByKeyboard.current = true;
          openContextMenuFromKeyboard(row);
        },
      }),
    [collapsed, onToggleCollapsed],
  );

  /** For the header's `ContextMenu.Content`. */
  const onCloseAutoFocus = useCallback((e: Event) => {
    if (menuOpenedByKeyboard.current) {
      e.preventDefault();
      headerRef.current?.focus();
    }
    menuOpenedByKeyboard.current = false;
  }, []);

  return { headerRef, onKeyDown, onCloseAutoFocus };
}

/** The `--project-color` a project or group row tints itself with. */
export function projectColorStyle(color: string | null | undefined): CSSProperties | undefined {
  return color ? ({ "--project-color": `var(--${color})` } as CSSProperties) : undefined;
}
