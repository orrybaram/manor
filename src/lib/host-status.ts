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
