import { useCallback, useEffect, useRef, useState } from "react";

/** How long the pointer rests on a tile before its popover opens. */
const HOVER_OPEN_DELAY_MS = 1000;
/** Grace for the pointer to cross from the tile to the popover and back. */
const HOVER_CLOSE_DELAY_MS = 300;

/**
 * Whether something opened from the popover — a context menu, a dialog, an
 * inline rename — still needs it. Closing would unmount it.
 */
function popoverInUse(): boolean {
  const content = document.querySelector('[data-testid="rail-workspace-popover"]');
  if (!content) return false;
  const active = document.activeElement;
  if (active instanceof HTMLInputElement && content.contains(active)) return true;
  return Array.from(
    document.querySelectorAll('[role="menu"], [role="dialog"], [role="alertdialog"]'),
  ).some((layer) => layer !== content && !content.contains(layer));
}

export type RailPopover = {
  /** The entry key whose popover is open. */
  openKey: string | null;
  /** Move focus into the popover as it opens. False for a hover open. */
  focusOnOpen: boolean;
  openNow: (key: string, focus: boolean) => void;
  setOpen: (key: string, open: boolean) => void;
  onTileEnter: (key: string) => void;
  onTileLeave: () => void;
  onContentEnter: () => void;
  onContentLeave: () => void;
};

/**
 * The rail's one popover (ADR-195): opens on a tile after the pointer rests
 * on it for a second, or at once while another tile's popover is already
 * open, so moving down the rail flips straight through projects.
 */
export function useRailPopover(): RailPopover {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const openKeyRef = useRef<string | null>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);

  const clearTimers = useCallback(() => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  }, []);
  useEffect(() => clearTimers, [clearTimers]);

  const show = useCallback((key: string | null, focus: boolean) => {
    openKeyRef.current = key;
    setOpenKey(key);
    setFocusOnOpen(focus);
  }, []);

  const openNow = useCallback(
    (key: string, focus: boolean) => {
      clearTimers();
      show(key, focus);
    },
    [clearTimers, show],
  );

  const setOpen = useCallback(
    (key: string, open: boolean) => {
      clearTimers();
      if (open) show(key, false);
      else if (openKeyRef.current === key) show(null, false);
    },
    [clearTimers, show],
  );

  const scheduleClose = useCallback(() => {
    clearTimers();
    const tryClose = () => {
      // Wait out a menu or dialog opened from the popover.
      if (popoverInUse()) closeTimer.current = window.setTimeout(tryClose, HOVER_CLOSE_DELAY_MS);
      else show(null, false);
    };
    closeTimer.current = window.setTimeout(tryClose, HOVER_CLOSE_DELAY_MS);
  }, [clearTimers, show]);

  const onTileEnter = useCallback(
    (key: string) => {
      clearTimers();
      const current = openKeyRef.current;
      if (current === key) return;
      // Another tile's popover is open: hand over at once, unless it's busy
      // with a menu or dialog.
      if (current !== null) {
        if (!popoverInUse()) show(key, false);
        return;
      }
      openTimer.current = window.setTimeout(() => show(key, false), HOVER_OPEN_DELAY_MS);
    },
    [clearTimers, show],
  );

  const onTileLeave = useCallback(() => {
    if (openKeyRef.current !== null) scheduleClose();
    else clearTimers();
  }, [clearTimers, scheduleClose]);

  const onContentEnter = useCallback(() => clearTimers(), [clearTimers]);

  return {
    openKey,
    focusOnOpen,
    openNow,
    setOpen,
    onTileEnter,
    onTileLeave,
    onContentEnter,
    onContentLeave: scheduleClose,
  };
}
