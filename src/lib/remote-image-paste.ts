/**
 * Paste a clipboard image into a remote pane (ADR-187 §4). Claude Code reads
 * an image from the clipboard of the machine it runs on, which on a remote
 * pane is the ssh box, not this one — so Manor uploads the image and pastes
 * its path there instead, and only when the pane actually runs remotely.
 */

import type { Terminal } from "@xterm/xterm";
import { LOCAL_HOST_ID } from "./hosts";
import { paneRemoteHost, useRemotePaneStore } from "../store/remote-pane-store";
import { useHostStore } from "../store/host-store";
import { useToastStore } from "../store/toast-store";

/** True when `paneId`'s session runs on a remote host, not this machine. */
export function isRemotePane(paneId: string): boolean {
  const hostId = paneRemoteHost(useRemotePaneStore.getState(), paneId);
  return !!hostId && hostId !== LOCAL_HOST_ID;
}

/** The ssh target a host badges as, or its id when main hasn't reported it. */
function hostLabel(hostId: string): string {
  const host = useHostStore.getState().hosts.find((h) => h.hostId === hostId);
  return host?.spec?.target ?? hostId;
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
  const result = await window.electronAPI.terminal.pasteClipboardImage(paneId);
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
      useToastStore.getState().addToast({
        id: `paste-clipboard-image-${paneId}`,
        message: `Couldn't paste image to ${host}`,
        status: "error",
        detail: result.message,
      });
      return;
    }
  }
}
