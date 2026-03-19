/**
 * useTerminalResize — ResizeObserver + fit addon for auto-fitting terminal.
 *
 * Debounces fit() calls via requestAnimationFrame to avoid flooding the PTY
 * with SIGWINCH during continuous window resizes, which causes the shell to
 * redraw the prompt many times and garble the terminal output.
 */

import { useEffect, useRef } from "react";
import type { FitAddon } from "@xterm/addon-fit";

export function useTerminalResize(
  containerRef: React.RefObject<HTMLDivElement | null>,
  fitAddon: FitAddon | null,
) {
  const observerRef = useRef<ResizeObserver | null>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !fitAddon) return;

    // Initial fit
    fitAddon.fit();

    observerRef.current = new ResizeObserver(() => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        fitAddon.fit();
      });
    });
    observerRef.current.observe(container);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [containerRef, fitAddon]);
}
