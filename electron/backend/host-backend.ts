/**
 * The one way a host's backend is built (ADR-183). Local or remote, a host
 * is the same four backends: ptys on its terminal-host daemon, and git,
 * shell and ports commands through an `Exec` that runs on its machine, plus
 * the `MachineFacts` that describe that machine. Only the client, the exec
 * and the facts differ between hosts.
 */

import type { TerminalHostClient } from "../terminal-host/client";
import type { WorkspaceBackend } from "./types";
import { DaemonPtyBackend } from "./daemon-pty";
import { ExecGitBackend } from "./exec-git";
import { ExecShellBackend } from "./exec-shell";
import { ExecPortsBackend } from "./exec-ports";
import { localExec, type Exec } from "./exec";
import { localFacts, type MachineFacts } from "./machine-facts";

/** A host's backends, before any connection policy is put on top. */
export interface HostBackend {
  readonly pty: DaemonPtyBackend;
  readonly git: ExecGitBackend;
  readonly shell: ExecShellBackend;
  readonly ports: ExecPortsBackend;
  readonly facts: MachineFacts;
}

export function createHostBackend(
  client: TerminalHostClient,
  exec: Exec,
  facts: MachineFacts,
  /** Names the machine in warnings; defaults to "this machine". */
  opts: { label?: string } = {},
): HostBackend {
  return {
    pty: new DaemonPtyBackend(client),
    git: new ExecGitBackend(exec),
    shell: new ExecShellBackend(exec, facts),
    ports: new ExecPortsBackend(exec, facts, opts.label),
    facts,
  };
}

/**
 * This machine's backend, over the local daemon's `client` (which carries
 * the app version it handshakes with).
 */
export function createLocalBackend(
  client: TerminalHostClient,
): WorkspaceBackend & HostBackend {
  const host = createHostBackend(client, localExec, localFacts());
  return {
    ...host,
    connect: () => host.pty.ensureConnected(),
    // Nothing to drop: the local daemon's connection is recovered (or given
    // up on) by the client itself and reported through `exit` stream events.
    disconnect: async () => {},
  };
}
