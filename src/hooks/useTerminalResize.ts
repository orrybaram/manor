/**
 * useTerminalResize — ResizeObserver + fit addon for auto-fitting terminal.
 */

import { useEffect, useRef } from "react";
import type { FitAddon } from "@xterm/addon-fit";

export function useTerminalResize(
  containerRef: React.RefObject<HTMLDivElement | null>,
  fitAddon: FitAddon | null,
) {
  const observerRef = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !fitAddon) return;

    // Initial fit
    fitAddon.fit();

    observerRef.current = new ResizeObserver(() => {
      fitAddon.fit();
    });
    observerRef.current.observe(container);

    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [containerRef, fitAddon]);
}
