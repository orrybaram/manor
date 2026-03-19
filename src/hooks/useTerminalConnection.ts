/**
 * useTerminalConnection — stable refs for electronAPI terminal IPC calls.
 */

import { useCallback, useRef } from "react";

export function useTerminalConnection(paneId: string) {
  const paneIdRef = useRef(paneId);
  paneIdRef.current = paneId;

  const write = useCallback((data: string) => {
    window.electronAPI.ptyWrite(paneIdRef.current, data);
  }, []);

  const resize = useCallback((cols: number, rows: number) => {
    window.electronAPI.ptyResize(paneIdRef.current, cols, rows);
  }, []);

  const create = useCallback((cwd: string | null, cols: number, rows: number) => {
    return window.electronAPI.ptyCreate(paneIdRef.current, cwd, cols, rows);
  }, []);

  /** Kill the PTY session in the daemon (user explicitly closed pane) */
  const close = useCallback(() => {
    window.electronAPI.ptyClose(paneIdRef.current);
  }, []);

  /** Detach from the PTY session without killing it (effect cleanup / app quit) */
  const detach = useCallback(() => {
    window.electronAPI.ptyDetach(paneIdRef.current);
  }, []);

  return { write, resize, create, close, detach };
}
