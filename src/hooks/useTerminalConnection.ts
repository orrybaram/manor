/**
 * useTerminalConnection — stable refs for electronAPI terminal IPC calls.
 */

import { useCallback, useRef } from "react";
import { awaitPaneHost, usePaneHostStore } from "../store/pane-host-store";
import { useProjectStore } from "../store/project-store";
import { remoteHostIdForWorkspace } from "../lib/hosts";
import { useHostStore } from "../store/host-store";
import { isPaneInputBlocked } from "../lib/host-status";
import { useAppStore, type PendingPaneCommand } from "../store/app-store";
import { shouldRequeuePaneCommand, windowPaneIds } from "../lib/remote-recovery";
import type { PtyCreateResult } from "../electron.d";

export function useTerminalConnection(paneId: string) {
  const paneIdRef = useRef(paneId);
  paneIdRef.current = paneId;

  /** Send `data` to the pane's pty. Returns whether it was delivered. */
  const write = useCallback((data: string): boolean => {
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
      return false;
    }
    window.electronAPI.pty.write(paneId, data);
    return true;
  }, []);

  /**
   * Put back a pane command a mount took from the queue but `write` never
   * delivered — the mount went first, say a remote pane remounted because
   * its host dropped again mid-recovery — so the next mount runs it rather
   * than it being lost (ADR-178 §6). See `shouldRequeuePaneCommand`.
   */
  const requeueUndelivered = useCallback((command: PendingPaneCommand) => {
    const paneId = paneIdRef.current;
    const app = useAppStore.getState();
    if (
      shouldRequeuePaneCommand(paneId, {
        remoteHostByPane: usePaneHostStore.getState().remoteHostByPane,
        windowPaneIds: windowPaneIds(app.workspaceLayouts),
        closedPaneIds: app.closedPaneIds,
        pendingPaneCommands: app.pendingPaneCommands,
      })
    ) {
      app.setPendingPaneCommand(paneId, command.text, { submit: command.submit });
    }
  }, []);

  const resize = useCallback((cols: number, rows: number) => {
    return window.electronAPI.pty.resize(paneIdRef.current, cols, rows);
  }, []);

  const create = useCallback(
    (cwd: string | null, cols: number, rows: number, agentKind?: string | null) => {
      const paneId = paneIdRef.current;
      // A pane of a remote project whose host is not known yet is assumed to
      // run there until create says otherwise, so a slow connect (the app
      // launched while the host is down) shows the host's banner meanwhile.
      if (cwd && !(paneId in usePaneHostStore.getState().remoteHostByPane)) {
        const projectHost = remoteHostIdForWorkspace(
          useProjectStore.getState().projects,
          cwd,
        );
        if (projectHost) usePaneHostStore.getState().setPaneHost(paneId, projectHost);
      }
      return window.electronAPI.pty
        .create(paneId, cwd, cols, rows, agentKind)
        .then((result: PtyCreateResult) => {
          // Badge the tab from where the session really runs (ADR-160).
          if (result.ok) usePaneHostStore.getState().setPaneHost(paneId, result.hostId);
          // Its remote host is away (ADR-178 §6): wait for it, not an error.
          else if (result.reason === "host-unavailable") {
            awaitPaneHost(paneId, result.hostId);
          }
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

  return { write, requeueUndelivered, resize, create, close, detach };
}
