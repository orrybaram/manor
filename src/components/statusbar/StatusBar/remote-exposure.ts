/**
 * What the remote-exposure badge says, derived from the remote-control status
 * alone (ADR-161 §5, ADR-206 D6). Kept out of the component so the rules —
 * which road is in what state, what colour that is, what a click does — can
 * be tested without rendering.
 */
import type {
  RelayStatus,
  RemoteControlStatus,
  TunnelStatus,
} from "../../../electron.d";

/** How one road out of this machine is doing, as the badge sees it. */
export type RoadState = "off" | "live" | "starting" | "retrying" | "failed";

export function tunnelState(tunnel: TunnelStatus): RoadState {
  if (tunnel.state === "running") return "live";
  if (tunnel.state === "starting") return "starting";
  if (tunnel.state === "failed") return "failed";
  return "off";
}

/**
 * The connector folds "the relay dropped, or was never reachable" into
 * `starting` with an `error`, and only gives up (`failed`) on a verdict like
 * a replaced host. Both deserve colour: one is a retry loop the user may not
 * know about, the other needs them to act.
 */
export function relayState(relay: RelayStatus): RoadState {
  if (relay.state === "running") return "live";
  if (relay.state === "starting") return relay.error ? "retrying" : "starting";
  if (relay.state === "failed") return "failed";
  return "off";
}

function connected(n: number): string {
  return n === 0 ? "nothing connected" : `${n} connected`;
}

function tunnelLine(tunnel: TunnelStatus, viewers: number): string | null {
  switch (tunnelState(tunnel)) {
    case "live":
      return `Tailscale: reachable at ${tunnel.url} (${connected(viewers)}).`;
    case "starting":
      return "Tailscale: starting the tunnel; not reachable yet.";
    case "failed":
      return `Tailscale: ${tunnel.error ?? "the tunnel stopped unexpectedly."}`;
    default:
      return null;
  }
}

function relayLine(relay: RelayStatus, viewers: number): string | null {
  switch (relayState(relay)) {
    case "live":
      return `Manor relay: reachable (${connected(viewers)}).`;
    case "starting":
      return "Manor relay: connecting.";
    case "retrying":
      return `Manor relay: can't reach the relay, retrying. ${relay.error}`;
    case "failed":
      return `Manor relay: ${relay.error ?? "stopped unexpectedly."}`;
    default:
      return null;
  }
}

export interface ExposureView {
  /** The badge's text. */
  text: string;
  tone: "ok" | "warning" | "failed";
  /** The tooltip: one sentence per road that is not off, then the action. */
  label: string;
  /** True while either road is up or trying to be; false: only failures. */
  exposed: boolean;
  /** The roads a click stops (everything not already stopped). */
  stop: { tunnel: boolean; relay: boolean };
}

/** Null when both roads are off — the badge renders nothing. */
export function describeExposure(
  status: Pick<
    RemoteControlStatus,
    "tunnel" | "relay" | "listeners" | "relayViewers"
  >,
): ExposureView | null {
  const { tunnel, relay, listeners, relayViewers } = status;
  const roads = [tunnelState(tunnel), relayState(relay)];
  if (roads.every((r) => r === "off")) return null;

  const failed = roads.includes("failed");
  const retrying = roads.includes("retrying");
  const live = roads.includes("live");
  const exposed = roads.some(
    (r) => r === "live" || r === "starting" || r === "retrying",
  );

  // `listeners` counts every connection; the relay's are its open channels.
  const lines = [
    tunnelLine(tunnel, Math.max(0, listeners - relayViewers)),
    relayLine(relay, relayViewers),
  ].filter((line): line is string => line !== null);
  const action = exposed
    ? roads.filter((r) => r !== "off").length > 1
      ? "Click to stop both."
      : "Click to stop."
    : "Click to dismiss.";

  let text: string;
  if (!exposed) {
    text = roads.every((r) => r === "failed")
      ? "REMOTE FAILED"
      : roads[0] === "failed"
        ? "TUNNEL FAILED"
        : "RELAY FAILED";
  } else if (live) {
    text = "REMOTE";
  } else if (retrying) {
    text = "RETRYING";
  } else {
    text = "STARTING";
  }

  return {
    text,
    tone: failed ? "failed" : retrying ? "warning" : "ok",
    label: [...lines, action].join(" "),
    exposed,
    stop: {
      tunnel: tunnel.state !== "stopped",
      relay: relay.state !== "stopped",
    },
  };
}
