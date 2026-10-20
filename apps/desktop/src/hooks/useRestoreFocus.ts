import { useCallback, useLayoutEffect, useRef } from "react";
import { useAppStore } from "../store/app-store";

/**
 * Cross-dialog chain state. Radix keeps a closing dialog's `FocusScope`
 * mounted (and its focus trap live) for the duration of its exit animation,
 * so restoring focus the moment `open` flips to `false` gets immediately
 * fought by that still-active trap. The fix Radix itself uses is to defer the
 * restore to `onCloseAutoFocus`, which only fires once the scope has actually
 * unmounted and released its trap — see `handleClose` below.
 *
 * That deferred timing is also what makes chained dialogs (the palette
 * opening Settings) hand off correctly: closing the palette and opening
 * Settings happen in the same commit, so restoring focus as soon as the
 * palette closes would just capture Settings' own input as "the origin" a
 * moment later. Instead, opening and closing share a depth counter: a dialog
 * only records `document.activeElement` as the chain's origin when no other
 * tracked dialog is already open, and only the dialog whose close brings the
 * depth back to zero actually moves focus.
 */
let chainDepth = 0;
let chainOrigin: Element | null = null;

/**
 * Remembers what had focus when a dialog opens and gives it back when it
 * closes, falling back to the active pane if that element is gone (removed
 * from the sidebar, tab closed, etc). Wire the returned `onCloseAutoFocus`
 * into the dialog's `Dialog.Content` — it also calls `preventDefault()` so
 * Radix doesn't fight it with its own default restore.
 */
export function useRestoreFocus(open: boolean): {
  onCloseAutoFocus: (e: Event) => void;
} {
  const wasOpenRef = useRef(false);
  // Whether this instance's open incremented `chainDepth` and hasn't paired
  // decrement yet — guards against double-decrementing if `onCloseAutoFocus`
  // somehow fires without a matching open (defensive; shouldn't happen).
  const countedRef = useRef(false);

  useLayoutEffect(() => {
    if (open && !wasOpenRef.current) {
      if (chainDepth === 0) chainOrigin = document.activeElement;
      chainDepth++;
      countedRef.current = true;
    }
    wasOpenRef.current = open;
  }, [open]);

  const onCloseAutoFocus = useCallback((e: Event) => {
    e.preventDefault();
    if (countedRef.current) {
      chainDepth = Math.max(0, chainDepth - 1);
      countedRef.current = false;
    }
    // Another dialog in the same chain is still (logically) open — leave
    // focus where it put it.
    if (chainDepth > 0) return;

    const origin = chainOrigin;
    chainOrigin = null;
    if (
      origin instanceof HTMLElement &&
      origin.isConnected &&
      origin !== document.body
    ) {
      origin.focus();
    } else {
      useAppStore.getState().refocusActivePane();
    }
  }, []);

  return { onCloseAutoFocus };
}
