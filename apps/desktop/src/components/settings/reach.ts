import type { HostServerView, RemoteControlStatus } from "../../electron.d";
import { describe } from "./remote-control-status";

/** Whether devices can reach a host, and the words for it. */
export type Reach = { reachable: boolean; text: string };

/**
 * Whether a remote host's Manor survives the host restarting, so devices
 * reach it "anytime": its container entrypoint runs it, or the user has it
 * supervised.
 */
export function isSupervised(view: Pick<HostServerView, "supervisor" | "supervise"> | null): boolean {
  return view?.supervisor?.kind === "container" || (view?.supervise ?? false);
}

/** How devices reach a remote host, from its server's view; null until that is known. */
export function hostReach(view: HostServerView | null): Reach | null {
  if (!view) return null;
  if (!view.linkPhones) return { reachable: false, text: "Devices off" };
  return { reachable: true, text: isSupervised(view) ? "Reachable anytime" : "Reachable" };
}

/** How devices reach This Mac: through the relay, so only while Manor is open. */
export function localReach(status: RemoteControlStatus): Reach {
  const view = describe(status);
  if (view.tone === "off") return { reachable: false, text: "Devices off" };
  if (view.tone === "ok") return { reachable: true, text: "Reachable while Manor is open" };
  return {
    reachable: false,
    text: view.title === "Turning on…" ? "Turning on…" : "Can't reach the relay",
  };
}
