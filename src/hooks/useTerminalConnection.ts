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
   * The `cols×rows` here is a *request*. It is refused silently when someone
   * who outranks this viewer already has the pane (ADR-178 D5), and the reply
   * carries the owner's grid instead — `useTerminalLifecycle` reads that into
   * its `follower` state. A window on the machine outranks a paired device
   * and is outranked only by a window that attached after it (ADR-180 D6), so
   * the common case — one viewer, or the one that just opened the pane — is
   * the owner asking, and nothing is refused.
   */
  const create = useCallback(
    (cwd: string | null, cols: number, rows: number, agentKind?: string | null) => {
      return window.electronAPI.pty.create(paneIdRef.current, cwd, cols, rows, agentKind);
    },
    [],
  );

  /** Detach from the PTY session without killing it (effect cleanup / app quit) */
  const detach = useCallback(() => {
    window.electronAPI.pty.detach(paneIdRef.current);
  }, []);

  return { write, resize, create, detach };
}
