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

/** The confirmation for removing a host profile (ADR-235 D2). */
export const REMOVE_PROFILE_TEXT = "Its hosts keep running. They'll no longer be grouped.";

/** The remove confirmation for a profile; one that signs new pods in also loses its Secret (ADR-235 D9). */
export function removeProfileText(profile: {
  values: Record<string, string>;
  signIn?: { github?: unknown; claude?: unknown };
}): string {
  if (!profile.signIn?.github && !profile.signIn?.claude) return REMOVE_PROFILE_TEXT;
  const namespace = profile.values.namespace?.trim() || "manor";
  return `${REMOVE_PROFILE_TEXT} Its sign-in tokens are deleted from ${namespace}. Running pods keep them until they restart.`;
}

/** A profile's template and where it points, for its row: "Kubernetes · prod / manor". */
export function profileSummary(templateName: string, values: Record<string, string>): string {
  const where = [values.context, values.namespace].filter((v) => v);
  return [templateName, ...(where.length > 0 ? [where.join(" / ")] : [])].join(" · ");
}

/** ADR-235 D9: the trade of "Sign new pods in for me", shown while it is on. */
export function signInWarningText(namespace: string): string {
  const where = namespace === "" ? "the profile's namespace" : namespace;
  return `Anyone who can read Secrets in ${where} or open a terminal in its pods can use these. Every agent in every pod can use them too. They are your own tokens, not scoped to a pod, so a namespace you share with other people is the wrong place for this.`;
}

/** "Set 3/14/2026 · from this computer" (ADR-235 D9): when and how a token was set. */
export function signInStatusText(meta: { setAt: number; source: "gh" | "pasted" }): string {
  const when = new Date(meta.setAt).toLocaleDateString();
  return `Set ${when} · ${meta.source === "gh" ? "from this computer" : "pasted token"}`;
}

/** What the Restart button reported (ADR-235 D9). */
export function restartedPodsText(count: number): string {
  if (count === 0) return "No pods were running.";
  return `Restarted ${count} ${count === 1 ? "pod" : "pods"}.`;
}

/** The Restart button (ADR-235 D9): "Restart 3 pods", from the hosts known to be running. */
export function restartPodsLabel(running: number): string {
  if (running === 0) return "Restart pods";
  return `Restart ${running} ${running === 1 ? "pod" : "pods"}`;
}

/**
 * Where the key Manor makes on a host goes, for an older server that doesn't
 * report `encryptKeyFile`.
 */
export const DEFAULT_KEY_FILE = "~/.config/manor/secret.key";

/** What can be done about plaintext pairing keys on a host (ADR-236 D6). */
export type KeyFix = "button" | "recipe" | "container" | "none";

/** The colour of the Pairing keys pill: a caution, protected, half-protected, or working. */
export type PairingKeysTone = "caution" | "ok" | "partial" | "busy";

/** The facts the Pairing keys row shows (ADR-236 D6). */
export type PairingKeysState = {
  tone: PairingKeysTone;
  /** The pill: "Unencrypted", "Encrypted", "Key kept with data", "Encrypting…". */
  state: string;
  /** The one line under the label. */
  hint: string;
  /** Opens on demand: what the state does and doesn't protect against. */
  detail: string | null;
  /** The few words the row's header repeats, or null when the state is fine. */
  headerWarning: string | null;
};

/** The facts about a host's pairing keys the row reads. */
export type PairingKeysFacts = {
  secretBackend: string;
  secretKeyPlace?: "data-dir" | "home" | "elsewhere";
  secretKeyFile?: string | null;
  secretKeyOnVolume?: boolean;
  encryptKeyFile?: string;
};

/**
 * The key sealing the pairing keys sits inside ~/.manor; an older server only
 * says so with `secretKeyOnVolume`. A key named while another backend seals
 * them (one sticky from before, ADR-236 D8) is not worth the warning.
 */
export function keyOnVolume(facts: PairingKeysFacts): boolean {
  return facts.secretKeyPlace === undefined
    ? facts.secretKeyOnVolume === true
    : facts.secretKeyPlace === "data-dir" && facts.secretBackend === "key-file";
}

/**
 * What the Pairing keys row says for a host (ADR-236 D6): its state as a
 * pill, one line, and the caveats behind a disclosure. `busy` is an Encrypt
 * click in flight, which the row shows as progress rather than letting the
 * server's restart read as a reset.
 */
export function pairingKeysState(
  facts: PairingKeysFacts,
  fix: KeyFix,
  hostName: string,
  busy = false,
): PairingKeysState {
  if (busy) {
    return {
      tone: "busy",
      state: "Encrypting…",
      hint: `Restarting ${hostName}'s server. Devices reconnect on their own.`,
      detail: null,
      headerWarning: "pairing keys unencrypted",
    };
  }
  if (facts.secretBackend === "plaintext") {
    const keyFile = facts.encryptKeyFile ?? DEFAULT_KEY_FILE;
    const hint =
      fix === "button"
        ? `Stored as plain files on ${hostName}. Manor can seal them in one step. Devices stay paired.`
        : fix === "recipe"
          ? "The recipe has to supply a key."
          : fix === "container"
            ? "Set a key in the container's environment."
            : `Encrypt them from the desktop app while ${hostName} is connected.`;
    return {
      tone: "caution",
      state: "Unencrypted",
      hint,
      detail:
        fix === "button"
          ? `Manor makes a key at ${keyFile} on ${hostName} and restarts its server to use it. A copy of ~/.manor can't read the pairing keys then. A copy of ${hostName}'s whole disk, or anyone with your account on it, still can.`
          : null,
      headerWarning: "pairing keys unencrypted",
    };
  }
  if (keyOnVolume(facts)) {
    return {
      tone: "partial",
      state: "Key kept with data",
      hint: `The key sits inside ~/.manor on ${hostName}, beside what it seals.`,
      detail: `A copy of ~/.manor carries the key with it, so it can read the pairing keys. Keep the key somewhere else on ${hostName} to change that.`,
      headerWarning: "pairing key stored on its disk",
    };
  }
  if (facts.secretBackend === "key-file") {
    const file = facts.secretKeyFile ?? null;
    const place = facts.secretKeyPlace;
    const hint =
      place === "home" || (place === "elsewhere" && file)
        ? `Sealed with a key at ${file ?? DEFAULT_KEY_FILE} on ${hostName}.`
        : place === "elsewhere"
          ? `Sealed with a key from ${hostName}'s environment.`
          : `Sealed with a key file on ${hostName}.`;
    return {
      tone: "ok",
      state: "Encrypted",
      hint,
      detail:
        place === "home"
          ? `Safe from a copy of ~/.manor. A copy of ${hostName}'s whole disk, or anyone with your account on it, can still read them. Deleting the key file strands the keys; Reset pairing keys recovers.`
          : null,
      headerWarning: null,
    };
  }
  const sealedBy =
    facts.secretBackend === "systemd-creds"
      ? `Sealed by systemd on ${hostName}.`
      : facts.secretBackend === "libsecret"
        ? `Sealed by ${hostName}'s keyring.`
        : `Sealed by ${hostName}.`;
  return { tone: "ok", state: "Encrypted", hint: sealedBy, detail: null, headerWarning: null };
}
