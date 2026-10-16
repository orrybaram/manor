/**
 * The desktop's side of supervision (ADR-229 D4): running
 * `manor-host supervisor install|uninstall|status --json` on a remote host,
 * through its transport's `exec` (ssh, or a recipe's exec prefix).
 *
 * `hosts.setSupervised` turns it on and off; `HostServerSync` installs it on
 * connect for a host whose record says `supervise` and whose server reports
 * none.
 */

import type { SupervisorFacts } from "../host-server/supervisor/types";
import type { HostTransport } from "../terminal-host/transport";
import { runHostJsonCommand } from "./host-json-command";

export type SupervisorAction = "install" | "uninstall" | "status";

/** systemd may wait on polkit for `enable-linger`; give the whole install room. */
const SUPERVISOR_EXEC_TIMEOUT_MS = 60_000;

const KINDS: readonly string[] = ["systemd", "launchd", "container"];

/** `supervisor … --json`'s facts or null; undefined when malformed. */
function readSupervisorFacts(value: unknown): SupervisorFacts | null | undefined {
  if (value === null) return null;
  const facts = value as { kind?: unknown; linger?: unknown } | undefined;
  if (!facts || typeof facts.kind !== "string" || !KINDS.includes(facts.kind)) return undefined;
  return {
    kind: facts.kind as SupervisorFacts["kind"],
    ...(typeof facts.linger === "boolean" ? { linger: facts.linger } : {}),
  };
}

/**
 * Run `supervisor <action> --json` on the host `transport` reaches. Answers
 * what supervises the host afterwards; rejects when the host cannot be
 * reached, or the command fails (with its own message, such as "No
 * supervisor on this host").
 */
export function runHostSupervisor(
  transport: HostTransport,
  action: SupervisorAction,
): Promise<SupervisorFacts | null> {
  return runHostJsonCommand(
    transport,
    `supervisor ${action}`,
    "supervisor",
    SUPERVISOR_EXEC_TIMEOUT_MS,
    readSupervisorFacts,
  );
}
