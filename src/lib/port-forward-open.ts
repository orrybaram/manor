import { addErrorToast } from "../store/toast-store";
import { useHostStore } from "../store/host-store";
import { hostLabel } from "./hosts";

/**
 * `url` — the box's own `localhost:<port>` URL — through its port forward on
 * `hostId`. Shared by `PortBadge`, the palette's port items and
 * `useRemoteBrowserUrl`. A forward that can't be made toasts and answers
 * `null`: opening the box's URL here instead would reach
 * whatever this machine has on that port.
 */
export async function forwardedUrl(url: string, hostId: string): Promise<string | null> {
  try {
    return await window.electronAPI.ports.resolveUrl(url, hostId);
  } catch (err) {
    let where = url;
    try {
      where = new URL(url).host;
    } catch {
      // not a URL; name it as given
    }
    addErrorToast(
      `port-forward-${hostId}-${where}`,
      `Couldn't forward ${where} from ${hostLabel(hostId, useHostStore.getState().hosts)}`,
      err,
    );
    return null;
  }
}

/** Kill the process on a port, toasting a failure. */
export async function killPortWithToast(pid: number, port: number): Promise<void> {
  try {
    await window.electronAPI.ports.killPort(pid);
  } catch (err) {
    addErrorToast(`kill-port-${pid}`, `Couldn't stop the process on port ${port}`, err);
  }
}
