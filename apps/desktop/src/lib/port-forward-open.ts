import type { ActivePort } from "../electron.d.ts";
import { toast } from "../toast";
import { useHostStore } from "../store/host-store";
import { hostLabel } from "./hosts";

/**
 * The URL a detected port opens at: its portless hostname if it has one,
 * else `localhost:<port>`. For a remote host's port, the box's own URL;
 * `forwardedUrl` turns it into one this machine can load.
 */
export function portUrl(port: ActivePort): string {
  return port.hostname ? `http://${port.hostname}` : `http://localhost:${port.port}`;
}

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
    const host = hostLabel(hostId, useHostStore.getState().hosts);
    toast.error(`Couldn't forward ${where} from ${host}`, {
      id: `port-forward-${hostId}-${where}`,
      error: err,
    });
    return null;
  }
}

/** Kill the process on a port, toasting a failure. */
export async function killPortWithToast(pid: number, port: number): Promise<void> {
  try {
    await window.electronAPI.ports.killPort(pid);
  } catch (err) {
    toast.error(`Couldn't stop the process on port ${port}`, {
      id: `kill-port-${pid}`,
      error: err,
    });
  }
}
