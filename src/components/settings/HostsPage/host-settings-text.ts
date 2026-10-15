/**
 * What the Hosts page says about a host's supervision and idle stop
 * (ADR-229 D4, D7), as plain functions so the wording is tested once.
 */

import type { HostServerView } from "../../../electron.d";
import type { HostSpec } from "../../../store/host-store";

type SupervisorFacts = NonNullable<HostServerView["supervisor"]>;

/**
 * The user Manor runs as on an ssh box, for the `loginctl` hint: the
 * target's `user@`, else `$USER`, which the user's shell on the box fills in.
 */
function loginUser(spec: HostSpec | null): string {
  if (spec?.kind !== "ssh") return "$USER";
  const at = spec.target.replace(/^ssh:\/\//, "").lastIndexOf("@");
  return at > 0 ? spec.target.replace(/^ssh:\/\//, "").slice(0, at) : "$USER";
}

/**
 * The line under "Keep Manor running when <host> restarts": what keeps it
 * running now (D4), or null when nothing is known to — the switch then
 * says enough.
 */
export function supervisorStatusText(
  supervisor: SupervisorFacts | null,
  hostName: string,
  spec: HostSpec | null,
): string | null {
  if (!supervisor) return null;
  switch (supervisor.kind) {
    case "systemd":
      return supervisor.linger === false
        ? `Starts after you log in to ${hostName}. Run \`sudo loginctl enable-linger ${loginUser(spec)}\` there to start it at boot.`
        : "Runs at boot (systemd)";
    case "launchd":
      return "Starts at login (launchd). A headless Mac needs automatic login.";
    case "container":
      return "Runs from the container's entrypoint";
  }
}

/**
 * Why the switch is as it is when no supervisor answers: off on a box the
 * user set up, on but not installed yet, or the host away.
 */
export function supervisionHint(
  view: Pick<HostServerView, "supervise" | "supervisor"> | null,
  hostName: string,
  connected: boolean,
): string | null {
  if (!connected) return `Change this while ${hostName} is connected.`;
  if (!view || view.supervisor) return null;
  return view.supervise
    ? `Not set up on ${hostName} yet: Manor sets it up on the next connect.`
    : `Off: after ${hostName} restarts, phones can't reach it until this computer connects again.`;
}

/** The idle-stop caveat for a recipe with nothing to stop it with the lid closed (D7). */
export function idleStopText(minutes: number | undefined, desktopName: string): string {
  const after = minutes === undefined ? "Stops when idle" : `Stops after ${minutes} min idle`;
  return `${after} only while ${desktopName} is awake`;
}
