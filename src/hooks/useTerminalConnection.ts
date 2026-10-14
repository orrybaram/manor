/**
 * useTerminalConnection — stable refs for electronAPI terminal IPC calls.
 */

import { useCallback, useRef } from "react";
import { paneRemoteHost, useRemotePaneStore } from "../store/remote-pane-store";
import { isRemoteHost, type HostId } from "../lib/hosts";
import { parseWorkspaceKey, type WorkspaceKey } from "../lib/workspace-key";
import { useAppStore } from "../store/app-store";
import { useHostStore } from "../store/host-store";
import { isHostAway } from "../bridge/server-set";
import type { PtyAttachResult, PtyCreateResult } from "../electron.d";

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
 * Note where a create or attach found the pane's session: badge the tab from
 * where it really runs (ADR-160), or wait for its remote host while it is
 * away (ADR-178 §6) — not an error.
 */
function recordPaneHost<R extends PtyCreateResult | PtyAttachResult>(
  paneId: string,
  result: R,
): R {
  const panes = useRemotePaneStore.getState();
  if (result.ok) panes.setPaneHost(paneId, result.hostId);
  else if (result.reason === "host-unavailable") panes.awaitHost(paneId, result.hostId);
  return result;
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
    // A host reached only through servers that are all gone is away too
    // (ADR-228 D6).
    if (
      isHostAway(
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
      // A pane restored at launch, mounting for the first time, is not the
      // user asking for its host (ADR-230 D3): a sleeping one stays asleep
      // and the pane waits behind its banner. Forgotten once that create
      // settles — not as it is sent, so React's dev double-mount sends the
      // same — and every create after it wakes the host as usual.
      const app = useAppStore.getState();
      const restored = app.restoredPaneIds.has(paneId);
      return window.electronAPI.pty
        .create(paneId, cwd, cols, rows, {
          agentKind,
          hostId,
          ...(restored && { wake: false }),
        })
        .finally(() => {
          if (restored) app.forgetRestoredPane(paneId);
        })
        .then((result: PtyCreateResult) => recordPaneHost(paneId, result));
    },
    [],
  );

  /**
   * Attach to the pane's running session, and nothing more (ADR-220): a
   * resync's way back in. No shell is spawned and no size asked for, and the
   * answer says `exited` or `lost` when the session ended meanwhile.
   */
  const attach = useCallback(() => {
    const paneId = paneIdRef.current;
    return window.electronAPI.pty
      .attach(paneId)
      .then((result: PtyAttachResult) => recordPaneHost(paneId, result));
  }, []);

  /** Detach from the PTY session without killing it (effect cleanup / app quit) */
  const detach = useCallback(() => {
    window.electronAPI.pty.detach(paneIdRef.current);
  }, []);

  return { write, resize, create, attach, detach };
}
