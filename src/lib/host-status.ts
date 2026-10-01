/**
 * Turns a `HostStatusInfo` into what every host indicator shows — the
 * sidebar icon, the status-bar chip, the pane banner and the project
 * settings field all render through `HostIndicator`, which reads this, so
 * the host has one icon, one colour scale and one vocabulary everywhere.
 *
 * Every actionable detail (the `ssh-add` hint, which tool is missing, the
 * `node scripts/build-host-tarball.mjs` hint, …) already lives in
 * `host.error` — it is the message `classifyHostFailure` produced server
 * side. This picks the short label, a plain-language summary and the tone,
 * keeping the failure modes (ADR-160 ticket 11 §3) distinguishable. The raw
 * `detail` stays available for anyone who wants the ssh output.
 *
 * Chips show the host's name and nothing else; the glyph and tone carry
 * the state, and `status`/`summary` are for the popover, tooltip and the
 * settings card.
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
  /**
   * What's wrong in plain words, without ssh's own phrasing: "Nothing
   * answered at 10.0.0.2:2222." Absent when there is nothing to add to
   * `status`.
   */
  summary?: string;
  /** The raw message (ssh output, the failure's actionable hint). */
  detail?: string;
  /** Whether "Retry" means anything (not while a connect is running). */
  canRetry: boolean;
}

type FailureReason = NonNullable<HostStatusInfo["failure"]>["reason"];

/** How each classified failure reads: short label, summary, banner line. */
const FAILURE_COPY: Record<
  FailureReason,
  { status: string; summary: string; banner: (target: string) => string }
> = {
  auth: {
    status: "Auth failed",
    summary: "ssh couldn't log in with your keys.",
    banner: (target) => `${target} rejected your ssh key`,
  },
  "host-key": {
    status: "Host key not trusted",
    summary: "The host's key isn't trusted: it's new, or it changed.",
    banner: (target) => `${target}'s host key isn't trusted`,
  },
  bootstrap: {
    status: "Setup failed",
    summary: "Connected, but couldn't set Manor up on the host.",
    banner: (target) => `Couldn't set Manor up on ${target}`,
  },
};

/**
 * An unclassified error that is ssh failing to reach the host at all (exit
 * 255 while connecting): down, asleep, wrong port, unknown name. Main keeps
 * retrying these — they are the network, not a permanent failure — so this
 * is only a label, never a `HostFailure` reason.
 */
function describeUnreachable(error: string | undefined): string | null {
  if (!error) return null;
  const at = /connect to host (\S+) port (\d+)/i.exec(error);
  const addr = at ? `${at[1]}:${at[2]}` : null;
  const resolve = /Could not resolve hostname ([^:\s]+)/i.exec(error);
  if (resolve) return `Couldn't find ${resolve[1]}. Check the hostname or your ssh config.`;
  if (/Connection refused/i.test(error)) {
    return `${addr ?? "The host"} refused the connection. Check sshd is running on that port.`;
  }
  if (/Host is down|timed out|No route to host|Network is unreachable/i.test(error)) {
    return `Nothing answered at ${addr ?? "the host"}. Check it's awake and on your network.`;
  }
  if (/exit 255/.test(error)) return "ssh couldn't reach the host.";
  return null;
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
        ...(warnings ? { summary: warnings, detail: warnings } : {}),
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
        banner: `Lost connection to ${target}. Reconnecting${when}`,
        summary: `Lost the connection. Reconnecting${when}`,
        canRetry: true,
      };
    }
    case "error": {
      const copy = host.failure ? FAILURE_COPY[host.failure.reason] : null;
      const unreachable = copy ? null : describeUnreachable(host.error);
      const summary = copy?.summary ?? unreachable;
      return {
        target,
        offline: true,
        busy: false,
        tone: "error",
        status: copy?.status ?? (unreachable ? "Unreachable" : "Connection failed"),
        banner:
          copy?.banner(target) ??
          (unreachable ? `${target} isn't responding` : `Connection to ${target} failed`),
        ...(summary ? { summary } : {}),
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
        status: "Not connected",
        banner: `Not connected to ${target}`,
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
 * Whether host `hostId` is away: main reported it and it is not connected.
 * `connecting`, `reconnecting`, `error` and `disconnected` all count as away,
 * as `describeHost` marks them `offline`. This machine (a missing id) and a
 * host main has not reported yet are never away.
 *
 * Typing into a pane on an away host is dropped, not queued (ADR-178 §6):
 * keystrokes replayed into a shell minutes later, into whatever is then in
 * the foreground, would do more harm than losing them. A linked group's
 * sections and host state (ADR-192 §5) read the same predicate.
 */
export function isHostOffline(
  hostId: string | null | undefined,
  hosts: readonly HostStatusInfo[],
): boolean {
  if (!hostId) return false;
  const host = hosts.find((h) => h.hostId === hostId);
  return host !== undefined && host.status !== "connected";
}

/**
 * A linked group's host state, from its members' hosts (ADR-192 §5):
 * `connected` when no member's host is away (`isHostOffline`, so a host
 * still connecting or reconnecting counts as away), `offline` when every
 * member's is, and `partially-offline` otherwise — one host dropped while the others
 * work, which must not read like a project that is wholly unreachable.
 */
export type GroupHostState = "connected" | "partially-offline" | "offline";

/**
 * The state of a group whose members live on `memberHostIds` (a missing id
 * is this machine). An empty group is `connected`: nothing is away.
 */
export function groupHostState(
  memberHostIds: readonly (string | null | undefined)[],
  hosts: readonly HostStatusInfo[],
): GroupHostState {
  const offline = memberHostIds.filter((id) => isHostOffline(id, hosts)).length;
  if (offline === 0) return "connected";
  return offline === memberHostIds.length ? "offline" : "partially-offline";
}
