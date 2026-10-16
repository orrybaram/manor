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
    : `Off: after ${hostName} restarts, devices can't reach it until this computer connects again.`;
}

/** The idle-stop caveat for a recipe with nothing to stop it with the lid closed (D7). */
export function idleStopText(minutes: number | undefined, desktopName: string): string {
  const after = minutes === undefined ? "Stops when idle" : `Stops after ${minutes} min idle`;
  return `${after} only while ${desktopName} is awake`;
}

/** Where the key Manor makes on a host goes, when the server hasn't named one. */
export const DEFAULT_KEY_FILE = "~/.config/manor/secret.key";

/** What "Encrypt them" does, and what it does not protect against (ADR-236 D6). */
export function plaintextFixText(hostName: string, keyFile: string = DEFAULT_KEY_FILE): string {
  return `Manor can make a key at ${keyFile} on ${hostName} and restart its server to use it. A copy of ~/.manor can't read the keys then; a copy of ${hostName}'s whole disk still can.`;
}

/** Plaintext keys on a recipe host: the recipe has to supply the key. */
export function plaintextRecipeText(hostName: string): string {
  return `${hostName} comes from a recipe, so Manor can't add a key to it. Have the recipe set one up.`;
}

/** Plaintext keys in a container: its environment has to supply the key. */
export function plaintextContainerText(hostName: string): string {
  return `${hostName} runs in a container, so Manor can't add a key to it. Give the container a key through its environment.`;
}

/** The key is a file in home, outside ~/.manor. */
export function keyInHomeText(hostName: string, keyFile: string = DEFAULT_KEY_FILE): string {
  return `Pairing keys on ${hostName} are encrypted with a key kept at ${keyFile}. That protects them from a copy of ~/.manor, but not from a copy of the whole disk.`;
}

/** The key sits inside ~/.manor, next to the keys it seals. */
export function keyOnVolumeText(hostName: string): string {
  return `The key sealing pairing keys is kept inside ~/.manor on ${hostName}, beside what it protects.`;
}
