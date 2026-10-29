/**
 * Paste an image into a pane whose host can't read this clipboard. Claude Code
 * reads an image from the clipboard of the machine it runs on, so Manor
 * uploads the image to the pane's host and pastes its path there instead.
 *
 * Two halves:
 * - Desktop: `pasteClipboardImage` has main read the native
 *   clipboard, only when the pane actually runs remotely.
 * - Web: `pasteImageFile` uploads the file the browser handed
 *   to the paste event, since no server can read the browser's clipboard.
 */

import type { Terminal } from "@xterm/xterm";
import { LOCAL_HOST_ID, hostName } from "./hosts";
import { paneRemoteHost, useRemotePaneStore } from "../store/remote-pane-store";
import { serverHostName } from "../bridge/server-set";
import { useHostStore } from "../store/host-store";
import { toast } from "../toast";
import { ipcErrorMessage } from "./ipc-error";
import { PASTED_IMAGE_CHUNK_BYTES } from "./pasted-image";
import { uploadPastedImage } from "./paste-image-upload";

/** True when `paneId`'s session runs on a remote host, not this machine. */
export function isRemotePane(paneId: string): boolean {
  const hostId = paneRemoteHost(useRemotePaneStore.getState(), paneId);
  return !!hostId && hostId !== LOCAL_HOST_ID;
}

/**
 * The name of a paired server (`serverHostName`: a browser stamps a server's
 * own panes with its relay room id), else a host badges as (`hostName`), else
 * its id when main hasn't reported it.
 */
function hostLabel(hostId: string): string {
  const server = serverHostName(hostId);
  if (server !== null) return server;
  const host = useHostStore.getState().hosts.find((h) => h.hostId === hostId);
  return host ? hostName(host) : hostId;
}

/**
 * Upload the clipboard image to `paneId`'s host and paste its path into
 * `term`. Falls back for a local pane (main answers `local` before touching
 * the clipboard) or an empty clipboard (`none`) — in both cases the caller's
 * ordinary paste path runs instead. An upload failure toasts and does not
 * fall back: the image was there, and silently sending `\x16`/nothing would
 * look like paste did nothing rather than that it failed.
 */
export async function pasteClipboardImage(
  term: Terminal,
  paneId: string,
  fallback: () => void,
): Promise<void> {
  // Name the host: main may never have heard of a pane made through the
  // host's viewer stream, and would take it for a local one.
  const result = await window.electronAPI.terminal.pasteClipboardImage(
    paneId,
    paneRemoteHost(useRemotePaneStore.getState(), paneId),
  );
  switch (result.kind) {
    case "uploaded":
      // Trailing space so the path stands alone as its own shell token —
      // matches how a locally-pasted file path is delivered.
      term.paste(result.path + " ");
      return;
    case "local":
    case "none":
      fallback();
      return;
    case "error": {
      const hostId = paneRemoteHost(useRemotePaneStore.getState(), paneId);
      const host = hostId ? hostLabel(hostId) : "the remote host";
      toast.error(`Couldn't paste image to ${host}`, {
        id: `paste-clipboard-image-${paneId}`,
        detail: result.message,
      });
      return;
    }
  }
}

/**
 * Upload an image the browser pasted to `paneId`'s host and
 * paste its path into `term`. Above one chunk the upload takes a few round
 * trips, so a loading toast covers it; a failure toasts under the same id.
 */
export async function pasteImageFile(
  term: Terminal,
  paneId: string,
  blob: Blob,
): Promise<void> {
  const hostId = paneRemoteHost(useRemotePaneStore.getState(), paneId);
  const host = hostId ? hostLabel(hostId) : "the host";
  const toastId = `paste-image-${paneId}`;
  if (blob.size > PASTED_IMAGE_CHUNK_BYTES) {
    toast.progress(`Uploading image to ${host}…`, { id: toastId });
  }
  try {
    const path = await uploadPastedImage(paneId, blob);
    toast.dismiss(toastId);
    // Trailing space, as in `pasteClipboardImage`.
    term.paste(path + " ");
  } catch (err) {
    toast.error(`Couldn't paste image to ${host}`, { id: toastId, detail: ipcErrorMessage(err) });
  }
}
