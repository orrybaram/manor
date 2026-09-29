import { useCallback, useRef, useState } from "react";
import { useMountEffect } from "../../../hooks/useMountEffect";

/**
 * Open-on-hover state for a popover: opens after `delay` so a pointer
 * sweeping across a row of triggers doesn't flash each one, and closes after
 * a short grace so the pointer can cross the gap into the popover. Put
 * `onEnter` / `onLeave` on both the trigger and the content.
 */
export function useHoverOpen(delay = 250, closeDelay = 150) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const onEnter = useCallback(() => {
    clear();
    timer.current = setTimeout(() => setOpen(true), delay);
  }, [clear, delay]);

  const onLeave = useCallback(() => {
    clear();
    timer.current = setTimeout(() => setOpen(false), closeDelay);
  }, [clear, closeDelay]);

  // A pending open/close timer must not fire after the trigger unmounts.
  useMountEffect(() => clear);

  return { open, setOpen, onEnter, onLeave };
}
