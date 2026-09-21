import type { ActivePort } from "../../ports";
import { portlessManager } from "../../portless";
import { assertPositiveInt, assertStringArray } from "../../ipc-validate";
import { publishRendererBroadcast } from "../../renderer-broadcast";
import type { IpcDeps, WorkspaceMeta } from "../../ipc/types";

/**
 * The port scanner, whole (ADR-180 ticket 8). Every one of these was already
 * an `ipcMain.handle` wrapper around a plain function; the wrappers are gone
 * now, and the handler table (`electron/bridge/handlers.ts`) is the only
 * caller left.
 *
 * `enrichPorts` used to close over a local `workspaceMeta` reassigned by
 * `updateWorkspaceMetadata` — that variable lived only as long as `register()`
 * did. `deps` is the one long-lived `IpcDeps` object app-lifecycle builds
 * once and hands to every table entry, so `deps.workspaceMeta` is where the
 * latest metadata lives now, and `portsUpdateWorkspaceMetadata` writes
 * straight through to it.
 */
function enrichPorts(deps: IpcDeps, ports: ActivePort[]): ActivePort[] {
  const proxyPort = portlessManager.proxyPort;
  const routes: { hostname: string; port: number }[] = [];
  for (const port of ports) {
    const meta = deps.workspaceMeta.find((m) => m.path === port.workspacePath);
    // portlessEnabled === false opts the project out — its ports keep the
    // plain `localhost:<port>` URL and contribute no proxy route.
    if (meta && proxyPort && meta.portlessEnabled !== false) {
      const hostname = portlessManager.hostnameForPort(
        meta.path,
        meta.projectName,
        meta.branch,
        meta.isMain,
      );
      routes.push({ hostname, port: port.port });
      // Include proxy port in hostname so renderer can build correct URLs
      port.hostname = `${hostname}:${proxyPort}`;
    }
  }
  portlessManager.updateRoutes(routes);
  return ports;
}

export function portsStartScanner(deps: IpcDeps): void {
  deps.portScanner.start((ports) => enrichPorts(deps, ports));
}

export function portsStopScanner(deps: IpcDeps): void {
  deps.portScanner.stop();
}

export function portsUpdateWorkspacePaths(
  deps: IpcDeps,
  paths: string[],
): void {
  assertStringArray(paths, "paths");
  deps.portScanner.updateWorkspacePaths(paths);
}

export function portsUpdateWorkspaceMetadata(
  deps: IpcDeps,
  meta: WorkspaceMeta[],
): void {
  deps.workspaceMeta = meta;
}

export async function portsScanNow(deps: IpcDeps): Promise<ActivePort[]> {
  const ports = await deps.portScanner.scanNow();
  return enrichPorts(deps, ports);
}

/**
 * `pid` is `MUTATING` (ADR-180 D4) — it ends a process the whole host can
 * see, the same "moves state the other viewers of this host will see" line
 * that put `projects.remove` there.
 */
export async function portsKillPort(deps: IpcDeps, pid: number): Promise<void> {
  assertPositiveInt(pid, "pid");
  try {
    await deps.backend.ports.kill(pid);
  } catch {
    // Process may have already exited — ignore
  }
  // Re-scan immediately so UI updates
  const ports = await deps.portScanner.scanNow();
  // Same signal the scanner's own tick publishes (ADR-180 D5), so a kill
  // reaches every renderer rather than only the primary window.
  publishRendererBroadcast("ports", "changed", enrichPorts(deps, ports));
}
