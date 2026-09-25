/**
 * Turns a `HostStatusInfo` into what the UI shows — the project settings host
 * field and the status-bar indicator both call this rather than each
 * inventing their own copy, so the four failure modes (ADR-160 ticket 11 §3)
 * stay distinguishable instead of collapsing into a generic "connection
 * failed".
 *
 * Every actionable detail (the `ssh-add` hint, which tool is missing, the
 * `node scripts/build-host-tarball.mjs` hint, …) already lives in
 * `host.error` — it is the message `classifyHostFailure` produced server
 * side. This only picks the short label and the tone the detail is shown in.
 */

import type { HostStatusInfo } from "../store/host-store";

export type HostStatusTone = "ok" | "pending" | "warn" | "error";

export interface HostStatusDisplay {
  label: string;
  detail?: string;
  tone: HostStatusTone;
}

function failureLabel(host: HostStatusInfo): string {
  switch (host.failure?.reason) {
    case "auth":
      return "Authentication failed";
    case "host-key":
      return "Host key not trusted";
    case "bootstrap":
      return "Could not set up the remote host";
    default:
      // A dropped connection while auto-reconnecting settled into "error"
      // (e.g. the daemon reported an unrecognized failure), rather than one
      // of the three failure modes above.
      return "Connection failed";
  }
}

export function describeHostStatus(host: HostStatusInfo): HostStatusDisplay {
  switch (host.status) {
    case "connected":
      return host.warnings && host.warnings.length > 0
        ? { label: "Connected", detail: host.warnings.join(" "), tone: "warn" }
        : { label: "Connected", tone: "ok" };
    case "connecting":
      return {
        label: "Connecting…",
        detail: host.progress,
        tone: "pending",
      };
    case "reconnecting":
      return {
        label: "Reconnecting…",
        detail:
          host.retryInMs != null
            ? `Retrying in ${Math.round(host.retryInMs / 1000)}s`
            : "The connection dropped; retrying.",
        tone: "pending",
      };
    case "error":
      return { label: failureLabel(host), detail: host.error, tone: "error" };
    case "disconnected":
    default:
      return { label: "Disconnected", tone: "pending" };
  }
}

/**
 * What a remote host that is not connected looks like on the things that
 * live on it (ADR-178 §6): the sidebar badge on its projects and the banner
 * over its panes. Null while connected — or unknown, e.g. before main has
 * reported hosts — when there is nothing to show.
 *
 * Being away is a normal state, not an error: nothing here is a toast, and
 * a routine drop reads "reconnecting", not "failed".
 */
export interface HostOfflineDisplay {
  /** Short, for the sidebar badge. */
  badge: string;
  /** One line for the pane banner. */
  banner: string;
  /** Longer explanation (the failure's actionable message), for a tooltip. */
  detail?: string;
  /** Whether "Retry now" means anything (not while a connect is running). */
  canRetry: boolean;
}

export function describeHostOffline(
  host: HostStatusInfo | undefined,
): HostOfflineDisplay | null {
  if (!host || host.status === "connected") return null;
  const target = host.spec?.target ?? host.hostId;
  switch (host.status) {
    case "reconnecting":
      return {
        badge: "Disconnected — reconnecting",
        banner: `Disconnected from ${target} — reconnecting`,
        canRetry: true,
      };
    case "connecting":
      return {
        badge: "Connecting…",
        banner: `Connecting to ${target}…`,
        ...(host.progress ? { detail: host.progress } : {}),
        canRetry: false,
      };
    case "error": {
      const label = describeHostStatus(host).label;
      return {
        badge: "Disconnected",
        banner: `${label} — ${target}`,
        ...(host.error ? { detail: host.error } : {}),
        canRetry: true,
      };
    }
    case "disconnected":
    default:
      return {
        badge: "Disconnected",
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
 * Whether typing into `paneId` must be dropped: its session runs on a remote
 * host that is not connected (ADR-178 §6). Input is dropped, not queued —
 * keystrokes replayed into a shell minutes later, into whatever is then in
 * the foreground, would do more harm than losing them. A local pane, or one
 * on a host main has not reported yet, is never blocked.
 */
export function isPaneInputBlocked(
  paneId: string,
  remoteHostByPane: Readonly<Record<string, string>>,
  hosts: readonly HostStatusInfo[],
): boolean {
  const hostId = remoteHostByPane[paneId];
  if (!hostId) return false;
  const host = hosts.find((h) => h.hostId === hostId);
  return host !== undefined && host.status !== "connected";
}
