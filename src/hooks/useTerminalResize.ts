/**
 * useTerminalResize — ResizeObserver + fit addon for auto-fitting terminal.
 *
 * Debounces fit() calls via requestAnimationFrame to avoid flooding the PTY
 * with SIGWINCH during continuous window resizes, which causes the shell to
 * redraw the prompt many times and garble the terminal output.
 *
 * Instead of useEffect, this uses a render-time guard: when fitAddon transitions
 * from null → value the component re-renders and the observer is set up
 * synchronously. useMountEffect handles teardown on unmount.
 */

import { useRef } from "react";
import { useMountEffect } from "./useMountEffect";
import type { FitAddon } from "@xterm/addon-fit";

export function useTerminalResize(
  containerRef: React.RefObject<HTMLDivElement | null>,
  fitAddon: FitAddon | null,
) {
  const observerRef = useRef<ResizeObserver | null>(null);
  const rafRef = useRef<number>(0);
  const fitAddonRef = useRef<FitAddon | null>(fitAddon);
  fitAddonRef.current = fitAddon;
  const prevFitAddonRef = useRef<FitAddon | null>(null);

  // Render-time setup: when fitAddon changes (null → value), tear down the
  // previous observer and create a new one. This is idempotent — if fitAddon
  // hasn't changed, this block is skipped entirely.
  if (fitAddon !== prevFitAddonRef.current) {
    prevFitAddonRef.current = fitAddon;

    // Tear down any existing observer
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    observerRef.current?.disconnect();
    observerRef.current = null;

    const container = containerRef.current;
    if (container && fitAddon) {
      fitAddon.fit();

      observerRef.current = new ResizeObserver(() => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
          fitAddonRef.current?.fit();
        });
      });
      observerRef.current.observe(container);
    }
  }

  // Cleanup on unmount
  useMountEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  });
}
