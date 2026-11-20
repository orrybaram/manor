/**
 * Which agent CLIs a host has, for Project Setup's agent list. Runs through
 * the host's own `ShellBackend`, so a remote project lists what its host
 * has installed rather than what this machine has.
 */

import { getAllConnectors } from "../agent-connectors";
import { findCliOnHost } from "./find-cli";
import type { ShellBackend } from "./types";

export interface DiscoveredAgent {
  name: string;
  command: string;
}

/**
 * Every agent whose CLI (named after its kind) is installed on `shell`'s
 * host, in connector order, so the first one is a stable default.
 */
export async function discoverAgentsOnHost(
  shell: ShellBackend,
): Promise<DiscoveredAgent[]> {
  const connectors = getAllConnectors();
  const found = await Promise.all(
    connectors.map(async (connector) =>
      (await findCliOnHost(shell, connector.kind))
        ? { name: connector.label, command: connector.defaultCommand }
        : null,
    ),
  );
  return found.filter((agent) => agent !== null);
}
