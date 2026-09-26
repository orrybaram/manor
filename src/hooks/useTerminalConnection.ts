/**
 * useTerminalConnection — stable refs for electronAPI terminal IPC calls.
 */

import { useCallback, useRef } from "react";

export function useTerminalConnection(paneId: string) {
  const paneIdRef = useRef(paneId);
  paneIdRef.current = paneId;

  const write = useCallback((data: string) => {
    window.electronAPI.pty.write(paneIdRef.current, data);
  }, []);

  const resize = useCallback((cols: number, rows: number) => {
    return window.electronAPI.pty.resize(paneIdRef.current, cols, rows);
  }, []);

  /**
   * Create or attach, and learn who owns this session's winsize.
   *
   * The `cols×rows` here is a *request*. Over the ADR-178 bridge it is refused
   * silently when a desktop window already has the pane (D5), and the reply
   * carries the owner's grid instead — `useTerminalLifecycle` reads that into
   * its `follower` state. On the preload path there is nothing to refuse: the
   * desktop asking is the owner asking.
   */
  const create = useCallback(
    (cwd: string | null, cols: number, rows: number, agentKind?: string | null) => {
      return window.electronAPI.pty.create(paneIdRef.current, cwd, cols, rows, agentKind);
    },
    [],
  );

  /** Kill the PTY session in the daemon (user explicitly closed pane) */
  const close = useCallback(() => {
    window.electronAPI.pty.close(paneIdRef.current);
  }, []);

  /** Detach from the PTY session without killing it (effect cleanup / app quit) */
  const detach = useCallback(() => {
    window.electronAPI.pty.detach(paneIdRef.current);
  }, []);

  return { write, resize, create, close, detach };
}
