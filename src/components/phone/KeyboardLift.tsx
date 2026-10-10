import { useEffect, useState } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { terminalFor } from "../../lib/terminal-registry";
import { selectFocusedPaneOfActiveTab, useAppStore } from "../../store/app-store";

/**
 * Keeps the focused terminal's cursor above the soft keyboard.
 *
 * The phone shell is sized to the small viewport so the keyboard never
 * resizes a pane (`Phone.module.css`), which leaves the keyboard covering the
 * pane's bottom rows — where the cursor and a TUI's prompt are — and nothing
 * scrolls them back (the page cannot scroll). So while a soft keyboard is up
 * for a terminal, this lifts the whole shell by a `translate`, which changes
 * no layout and so no row count, just far enough that the cursor's row clears
 * the keyboard.
 *
 * The chat view's composer (ADR-215 D7) is lifted the same way: an element
 * inside `[data-keyboard-lift]` with focus lifts the shell until that
 * container's bottom clears the keyboard.
 */

type FocusTarget = "terminal" | "lift" | null;

function focusTarget(): FocusTarget {
  const el = document.activeElement;
  if (!el) return null;
  if (el.classList.contains("xterm-helper-textarea")) return "terminal";
  if (el.closest("[data-keyboard-lift]")) return "lift";
  return null;
}

/** Less than this between the layout and visual viewports is not a keyboard
 *  (a collapsing URL bar is ~60px). */
const KEYBOARD_MIN_PX = 80;

/** The bottom of the visual viewport, in layout-viewport coordinates. */
function visibleBottom(): number {
  const vv = window.visualViewport;
  return vv ? vv.offsetTop + vv.height : window.innerHeight;
}

/** Set on `:root`; `Phone.module.css` lifts the phone shell by it. */
const SHIFT_VAR = "--phone-keyboard-shift";

export function KeyboardLift() {
  const paneId = useAppStore(selectFocusedPaneOfActiveTab);
  const [target, setTarget] = useState(focusTarget);
  const [bottom, setBottom] = useState(visibleBottom);

  useMountEffect(() => {
    const onFocus = () => setTarget(focusTarget());
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onFocus);
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onFocus);
    };
  });

  const focused = target !== null;

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !focused) return;
    const onViewport = () => setBottom(visibleBottom());
    onViewport();
    vv.addEventListener("resize", onViewport);
    vv.addEventListener("scroll", onViewport);
    return () => {
      vv.removeEventListener("resize", onViewport);
      vv.removeEventListener("scroll", onViewport);
    };
  }, [focused]);

  const keyboardUp = focused && window.innerHeight - bottom >= KEYBOARD_MIN_PX;

  useEffect(() => {
    if (!keyboardUp || target !== "lift") return;
    const root = document.documentElement;
    const box = document.activeElement?.closest("[data-keyboard-lift]");
    if (!box) return;
    // Measured with no lift applied: the previous run's cleanup removed it.
    const shift = Math.max(0, Math.ceil(box.getBoundingClientRect().bottom - bottom));
    if (shift > 0) root.style.setProperty(SHIFT_VAR, `${shift}px`);
    return () => {
      root.style.removeProperty(SHIFT_VAR);
    };
  }, [keyboardUp, target, bottom]);

  useEffect(() => {
    const root = document.documentElement;
    const term = keyboardUp && target === "terminal" && paneId ? terminalFor(paneId) : undefined;
    if (!term) return;
    let shift = 0;
    const place = () => {
      const screen = term.element?.querySelector(".xterm-screen");
      if (!screen || term.rows === 0) return;
      const rect = screen.getBoundingClientRect();
      const rowHeight = rect.height / term.rows;
      const buf = term.buffer.active;
      const row = Math.min(term.rows - 1, Math.max(0, buf.cursorY + buf.baseY - buf.viewportY));
      // Where the row's bottom is with no lift at all.
      const rowBottom = rect.top + shift + (row + 1) * rowHeight;
      const next = Math.max(0, Math.ceil(rowBottom - bottom));
      if (next === shift) return;
      shift = next;
      if (shift > 0) root.style.setProperty(SHIFT_VAR, `${shift}px`);
      else root.style.removeProperty(SHIFT_VAR);
    };
    place();
    const subs = [term.onCursorMove(place), term.onScroll(place), term.onResize(place)];
    return () => {
      for (const sub of subs) sub.dispose();
      root.style.removeProperty(SHIFT_VAR);
    };
  }, [keyboardUp, target, paneId, bottom]);

  return null;
}
