/**
 * useTerminalConnection — stable refs for electronAPI terminal IPC calls.
 */

import { useCallback, useRef } from "react";
import { paneRemoteHost, useRemotePaneStore } from "../store/remote-pane-store";
import { isRemoteHost, type HostId } from "../lib/hosts";
import { parseWorkspaceKey, type WorkspaceKey } from "../lib/workspace-key";
import { useHostStore } from "../store/host-store";
import { isHostOffline } from "../lib/host-status";
import type { PtyCreateResult } from "../electron.d";

/**
 * The host a pane's new session runs on, for create and reset alike. A pane
 * known to run on a remote host keeps it — it may have been moved there, or
 * its project moved away from it (ADR-183) — else it is the host named by
 * the key of the workspace it belongs to (ADR-191), never a guess from its
 * path: a restored pane goes back to its own host even when another host's
 * project with the same path is selected. Undefined with no workspace, so
 * main falls back to the host its cwd belongs to. Main attaches an existing
 * session wherever it already runs regardless.
 */
export function paneCreateHostId(
  paneId: string,
  workspaceKey: string | null | undefined,
  remotePanes: Parameters<typeof paneRemoteHost>[0] = useRemotePaneStore.getState(),
): HostId | undefined {
  return (
    paneRemoteHost(remotePanes, paneId) ??
    (workspaceKey ? parseWorkspaceKey(workspaceKey).hostId : undefined)
  );
}

/**
 * `workspaceKey` is the key of the workspace the pane belongs to (not its
 * cwd, which can be anywhere): its host is where the pane's session is
 * created.
 */
export function useTerminalConnection(paneId: string, workspaceKey?: WorkspaceKey | null) {
  const paneIdRef = useRef(paneId);
  paneIdRef.current = paneId;
  const workspaceKeyRef = useRef(workspaceKey);
  workspaceKeyRef.current = workspaceKey;

  /** Send `data` to the pane's pty. Returns whether it was delivered. */
  const write = useCallback((data: string): boolean => {
    const paneId = paneIdRef.current;
    // Read-only while the pane's remote host is away (ADR-178 §6): input is
    // dropped, not queued for a shell that may be gone by the time it lands.
    if (
      isHostOffline(
        paneRemoteHost(useRemotePaneStore.getState(), paneId),
        useHostStore.getState().hosts,
      )
    ) {
      return false;
    }
    window.electronAPI.pty.write(paneId, data);
    return true;
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
      const paneId = paneIdRef.current;
      // Name the host outright: a path alone can't tell a local and a remote
      // workspace with the same path apart (main's guess picks local).
      const hostId = paneCreateHostId(paneId, workspaceKeyRef.current);
      // A pane of a remote workspace whose host is not known yet is assumed
      // to run there until create says otherwise, so a slow connect (the app
      // launched while the host is down) shows the host's banner meanwhile.
      const panes = useRemotePaneStore.getState();
      if (hostId && isRemoteHost(hostId) && !paneRemoteHost(panes, paneId)) {
        panes.setPaneHost(paneId, hostId);
      }
      return window.electronAPI.pty
        .create(paneId, cwd, cols, rows, { agentKind, hostId })
        .then((result: PtyCreateResult) => {
          // Badge the tab from where the session really runs (ADR-160).
          if (result.ok) useRemotePaneStore.getState().setPaneHost(paneId, result.hostId);
          // Its remote host is away (ADR-178 §6): wait for it, not an error.
          else if (result.reason === "host-unavailable") {
            useRemotePaneStore.getState().awaitHost(paneId, result.hostId);
          }
          return result;
        });
    },
    [],
  );

  /** Detach from the PTY session without killing it (effect cleanup / app quit) */
  const detach = useCallback(() => {
    window.electronAPI.pty.detach(paneIdRef.current);
  }, []);

  return { write, resize, create, detach };
}
