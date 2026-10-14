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
import { REMOTE_HOST_BIN } from "../terminal-host/ssh-config";
import type { HostTransport } from "../terminal-host/transport";

export type SupervisorAction = "install" | "uninstall" | "status";

/** systemd may wait on polkit for `enable-linger`; give the whole install room. */
const SUPERVISOR_EXEC_TIMEOUT_MS = 60_000;

const KINDS: readonly string[] = ["systemd", "launchd", "container"];

/** Read `supervisor … --json`'s one line: the facts, null, or its error. */
function parseSupervisorOutput(stdout: string): SupervisorFacts | null {
  const line = stdout.trim().split("\n").pop() ?? "";
  let parsed: { supervisor?: unknown; error?: unknown };
  try {
    parsed = JSON.parse(line) as typeof parsed;
  } catch {
    throw new Error(`manor-host supervisor said something unreadable: ${line.slice(0, 200)}`);
  }
  if (typeof parsed.error === "string") throw new Error(parsed.error);
  const value = parsed.supervisor;
  if (value === null) return null;
  const facts = value as { kind?: unknown; linger?: unknown } | undefined;
  if (!facts || typeof facts.kind !== "string" || !KINDS.includes(facts.kind)) {
    throw new Error(`manor-host supervisor said something unreadable: ${line.slice(0, 200)}`);
  }
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
export async function runHostSupervisor(
  transport: HostTransport,
  action: SupervisorAction,
): Promise<SupervisorFacts | null> {
  if (!transport.exec) throw new Error("This host can't run commands.");
  const { code, stdout, stderr } = await transport.exec(
    `exec ${REMOTE_HOST_BIN} supervisor ${action} --json`,
    { timeoutMs: SUPERVISOR_EXEC_TIMEOUT_MS },
  );
  if (stdout.trim() === "" && code !== 0) {
    const detail = stderr.trim().slice(-300);
    throw new Error(
      `manor-host supervisor ${action} exited (code ${code ?? "none"})${detail ? `: ${detail}` : ""}`,
    );
  }
  return parseSupervisorOutput(stdout);
}
