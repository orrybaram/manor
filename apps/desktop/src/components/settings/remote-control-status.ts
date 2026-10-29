import type { RemoteControlStatus } from "../../electron.d";

/**
 * What this computer's remote control is doing, in words: shared by the This
 * Mac row on Settings → Hosts and the Devices page.
 */
export type StatusView = {
  tone: "off" | "ok" | "pending" | "bad";
  title: string;
  detail: string;
  /** A button beside the switch: retrying a relay that is down. */
  retry: string | null;
};

/**
 * Whether remote control shows as on. Enabled with the relay stopped (after a
 * reset, or enabled through the agent API, which never starts the relay)
 * reaches nothing, so it reads as off; turning it on starts the relay.
 */
export function isOn(status: RemoteControlStatus): boolean {
  return status.enabled && status.relay.state !== "stopped";
}

/**
 * What the switch says for each state. The connector reports "cannot reach
 * the relay, retrying" as `starting` with an error and gives up (`failed`)
 * only on a verdict — the first is a warning that it is still trying, the
 * second an error to act on, never a bare "Connecting…" that hides why.
 */
export function describe(status: RemoteControlStatus): StatusView {
  const { relay } = status;
  if (!isOn(status)) {
    return {
      tone: "off",
      title: "Remote control is off",
      // `startIfAsked` skips a launch it cannot store tokens for.
      detail: status.startOnLaunch && status.encryptionAvailable
        ? "Turn on to check on your agents from your phone. Turns on again next time Manor opens."
        : "Turn on to check on your agents from your phone. Turns off again when Manor quits.",
      retry: null,
    };
  }
  if (relay.state === "running") {
    const n = status.relayViewers;
    return {
      tone: "ok",
      title: "Remote control is on",
      detail:
        n === 0
          ? "Your devices can connect. None connected right now."
          : `${n} device${n === 1 ? "" : "s"} connected.`,
      retry: null,
    };
  }
  if (relay.state === "starting") {
    return relay.error
      ? {
          tone: "pending",
          title: "Can't reach the relay",
          detail: `Still trying — paired devices can't reach this machine until it connects. ${relay.error}`,
          retry: null,
        }
      : {
          tone: "pending",
          title: "Turning on…",
          detail: "Paired devices can reach this machine once it connects.",
          retry: null,
        };
  }
  return {
    tone: "bad",
    title: "Can't reach the relay",
    detail: relay.error ?? "The relay connection failed.",
    retry: "Try again",
  };
}
