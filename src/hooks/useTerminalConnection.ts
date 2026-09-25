/**
 * useTerminalConnection — stable refs for electronAPI terminal IPC calls.
 */

import { useCallback, useRef } from "react";
import { usePaneHostStore } from "../store/pane-host-store";
import { useHostStore } from "../store/host-store";
import { isPaneInputBlocked } from "../lib/host-status";

export function useTerminalConnection(paneId: string) {
  const paneIdRef = useRef(paneId);
  paneIdRef.current = paneId;

  const write = useCallback((data: string) => {
    const paneId = paneIdRef.current;
    // Read-only while the pane's remote host is away (ADR-178 §6): input is
    // dropped, not queued for a shell that may be gone by the time it lands.
    if (
      isPaneInputBlocked(
        paneId,
        usePaneHostStore.getState().remoteHostByPane,
        useHostStore.getState().hosts,
      )
    ) {
      return;
    }
    window.electronAPI.pty.write(paneId, data);
  }, []);

  const resize = useCallback((cols: number, rows: number) => {
    return window.electronAPI.pty.resize(paneIdRef.current, cols, rows);
  }, []);

  const create = useCallback(
    (cwd: string | null, cols: number, rows: number, agentKind?: string | null) => {
      const paneId = paneIdRef.current;
      return window.electronAPI.pty
        .create(paneId, cwd, cols, rows, agentKind)
        .then((result) => {
          // Badge the tab from where the session really runs (ADR-160).
          if (result.ok) usePaneHostStore.getState().setPaneHost(paneId, result.hostId);
          return result;
        });
    },
    [],
  );

  /** Kill the PTY session in the daemon (user explicitly closed pane) */
  const close = useCallback(() => {
    window.electronAPI.pty.close(paneIdRef.current);
    usePaneHostStore.getState().forgetPane(paneIdRef.current);
  }, []);

  /** Detach from the PTY session without killing it (effect cleanup / app quit) */
  const detach = useCallback(() => {
    window.electronAPI.pty.detach(paneIdRef.current);
  }, []);

  return { write, resize, create, close, detach };
}
