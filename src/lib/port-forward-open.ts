import { addErrorToast } from "../store/toast-store";
import { useHostStore } from "../store/host-store";
import { hostLabel } from "./hosts";

/**
 * A remote host's dev-server `url` through its port forward (ADR-178 §5). A
 * forward that can't be made toasts and answers `null` (ADR-232 D8) — opening
 * the box's `localhost:<port>` here would reach whatever this machine has on
 * it.
 */
export async function forwardedUrl(
  url: string,
  hostId: string,
  port: number,
): Promise<string | null> {
  try {
    return await window.electronAPI.ports.resolveUrl(url, hostId);
  } catch (err) {
    addErrorToast(
      `port-forward-${hostId}-${port}`,
      `Couldn't forward port ${port} from ${hostLabel(hostId, useHostStore.getState().hosts)}`,
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
