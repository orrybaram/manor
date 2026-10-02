/**
 * What the remote-exposure badge says, derived from the remote-control status
 * alone (ADR-161 §5, ADR-206 D6). Kept out of the component so the rules —
 * what state the relay is in, what colour that is — can be tested without
 * rendering.
 */
import type { RelayStatus, RemoteControlStatus } from "../../../electron.d";

/** How the relay is doing, as the badge sees it. */
type RelayBadgeState = "off" | "live" | "starting" | "retrying" | "failed";

/**
 * The connector folds "the relay dropped, or was never reachable" into
 * `starting` with an `error`, and only gives up (`failed`) on a verdict like
 * a replaced host. Both deserve colour: one is a retry loop the user may not
 * know about, the other needs them to act.
 */
function relayState(relay: RelayStatus): RelayBadgeState {
  if (relay.state === "running") return "live";
  if (relay.state === "starting") return relay.error ? "retrying" : "starting";
  if (relay.state === "failed") return "failed";
  return "off";
}

function connected(n: number): string {
  return n === 0 ? "nothing connected" : `${n} connected`;
}

export interface ExposureView {
  /** The badge's text. */
  text: string;
  tone: "ok" | "warning" | "failed";
  /** The tooltip: what the relay is doing, then the action. */
  label: string;
  /** True while the relay is up or trying to be; false: it failed. */
  exposed: boolean;
}

/** Null when the relay is off — the badge renders nothing. */
export function describeExposure(
  status: Pick<RemoteControlStatus, "relay" | "relayViewers">,
): ExposureView | null {
  const { relay, relayViewers } = status;
  switch (relayState(relay)) {
    case "live":
      return {
        text: "REMOTE",
        tone: "ok",
        label: `Manor relay: reachable (${connected(relayViewers)}). Click to stop.`,
        exposed: true,
      };
    case "starting":
      return {
        text: "STARTING",
        tone: "ok",
        label: "Manor relay: connecting. Click to stop.",
        exposed: true,
      };
    case "retrying":
      return {
        text: "RETRYING",
        tone: "warning",
        label: `Manor relay: can't reach the relay, retrying. ${relay.error} Click to stop.`,
        exposed: true,
      };
    case "failed":
      return {
        text: "RELAY FAILED",
        tone: "failed",
        label: `Manor relay: ${relay.error ?? "stopped unexpectedly."} Click to dismiss.`,
        exposed: false,
      };
    default:
      return null;
  }
}
