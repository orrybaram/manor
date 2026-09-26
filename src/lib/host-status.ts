/**
 * Turns a `HostStatusInfo` into what every host indicator shows — the
 * sidebar icon, the status-bar chip, the pane banner and the project
 * settings field all render through `HostIndicator`, which reads this, so
 * the host has one icon, one colour scale and one vocabulary everywhere.
 *
 * Every actionable detail (the `ssh-add` hint, which tool is missing, the
 * `node scripts/build-host-tarball.mjs` hint, …) already lives in
 * `host.error` — it is the message `classifyHostFailure` produced server
 * side. This only picks the short label and the tone the detail is shown in,
 * keeping the failure modes (ADR-160 ticket 11 §3) distinguishable.
 *
 * Being away is a normal state, not an error (ADR-178 §6): a routine drop
 * reads "reconnecting", in the warning tone, never "failed".
 */

import type { HostStatusInfo } from "../store/host-store";

export type HostTone = "ok" | "warn" | "error";

export interface HostDisplay {
  /** The ssh target, e.g. `wsl-box` — how the user named the host. */
  target: string;
  /** Anything but connected: the host's panes are read-only. */
  offline: boolean;
  /** Connecting for the first time or after a retry — shown pulsing. */
  busy: boolean;
  tone: HostTone;
  /** Sentence-case state on its own: "Connected", "Reconnecting in 4s". */
  status: string;
  /** One line naming the host, for the pane banner. */
  banner: string;
  /** Longer explanation (the failure's actionable message), for a tooltip. */
  detail?: string;
  /** Whether "Retry" means anything (not while a connect is running). */
  canRetry: boolean;
}

function failureLabel(host: HostStatusInfo): string | null {
  switch (host.failure?.reason) {
    case "auth":
      return "Authentication failed";
    case "host-key":
      return "Host key not trusted";
    case "bootstrap":
      return "Couldn't set up the remote host";
    default:
      return null;
  }
}

/**
 * The display for `host`; `now` drives the reconnect countdown. Undefined
 * for a host main hasn't reported yet.
 */
export function describeHost(
  host: HostStatusInfo | undefined,
  now: number,
): HostDisplay | undefined {
  if (!host) return undefined;
  const target = host.spec?.target ?? host.hostId;
  switch (host.status) {
    case "connected": {
      const warnings = host.warnings?.length ? host.warnings.join(" ") : undefined;
      return {
        target,
        offline: false,
        busy: false,
        tone: warnings ? "warn" : "ok",
        status: warnings ? "Connected with warnings" : "Connected",
        banner: `Connected to ${target}`,
        ...(warnings ? { detail: warnings } : {}),
        canRetry: false,
      };
    }
    case "connecting":
      return {
        target,
        offline: true,
        busy: true,
        tone: "warn",
        status: "Connecting…",
        banner: `Connecting to ${target}…`,
        ...(host.progress ? { detail: host.progress } : {}),
        canRetry: false,
      };
    case "reconnecting": {
      const seconds = secondsUntilRetry(host, now);
      const when = seconds !== null && seconds > 0 ? ` in ${seconds}s` : "…";
      return {
        target,
        offline: true,
        busy: false,
        tone: "warn",
        status: `Reconnecting${when}`,
        banner: `Reconnecting to ${target}${when}`,
        canRetry: true,
      };
    }
    case "error": {
      const label = failureLabel(host);
      return {
        target,
        offline: true,
        busy: false,
        tone: "error",
        status: label ?? "Can't connect",
        banner: label
          ? `Can't connect to ${target}: ${label.charAt(0).toLowerCase()}${label.slice(1)}`
          : `Can't connect to ${target}`,
        ...(host.error ? { detail: host.error } : {}),
        canRetry: true,
      };
    }
    case "disconnected":
    default:
      return {
        target,
        offline: true,
        busy: false,
        tone: "warn",
        status: "Disconnected",
        banner: `Disconnected from ${target}`,
        canRetry: true,
      };
  }
}

/**
 * Whole seconds until a reconnecting host's next attempt, or null when no
 * attempt is scheduled (not reconnecting, or the delay is unknown).
 */
export function secondsUntilRetry(
  host: HostStatusInfo | undefined,
  now: number,
): number | null {
  if (host?.status !== "reconnecting" || host.retryAt === undefined) return null;
  return Math.max(0, Math.ceil((host.retryAt - now) / 1000));
}

/**
 * Whether typing into a pane on remote host `hostId` (undefined for a local
 * pane) must be dropped: that host is not connected (ADR-178 §6). Input is
 * dropped, not queued — keystrokes replayed into a shell minutes later, into
 * whatever is then in the foreground, would do more harm than losing them.
 * A local pane, or one on a host main has not reported yet, is never blocked.
 */
export function isPaneInputBlocked(
  hostId: string | undefined,
  hosts: readonly HostStatusInfo[],
): boolean {
  if (!hostId) return false;
  const host = hosts.find((h) => h.hostId === hostId);
  return host !== undefined && host.status !== "connected";
}
