import type { ActivePort } from "../../ports";
import { portlessManager } from "../../portless";
import { assertPositiveInt, assertStringArray } from "../../ipc-validate";
import { publishRendererBroadcast } from "../../renderer-broadcast";
import type { HostDeps, WorkspaceMeta } from "../../ipc/types";
import { method, type HandlerCtx } from "../method";

/**
 * The port scanner, whole, as the `ports` namespace of the
 * handler table.
 *
 * `deps` is the one long-lived `HostDeps` object app-lifecycle builds once
 * and hands to every table entry, so `deps.workspaceMeta` is where the latest
 * metadata lives, and `portsUpdateWorkspaceMetadata` writes straight through
 * to it.
 */
function enrichPorts(deps: HostDeps, ports: ActivePort[]): ActivePort[] {
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

export function portsStartScanner(ctx: HandlerCtx): void {
  ctx.deps.portScanner.start((ports) => enrichPorts(ctx.deps, ports));
}

export function portsStopScanner(ctx: HandlerCtx): void {
  ctx.deps.portScanner.stop();
}

export function portsUpdateWorkspacePaths(
  ctx: HandlerCtx,
  paths: string[],
): void {
  assertStringArray(paths, "paths");
  ctx.deps.portScanner.updateWorkspacePaths(paths);
}

export function portsUpdateWorkspaceMetadata(
  ctx: HandlerCtx,
  meta: WorkspaceMeta[],
): void {
  ctx.deps.workspaceMeta = meta;
}

export async function portsScanNow(ctx: HandlerCtx): Promise<ActivePort[]> {
  const ports = await ctx.deps.portScanner.scanNow();
  return enrichPorts(ctx.deps, ports);
}

/** Ends a process the whole host can see. */
export async function portsKillPort(ctx: HandlerCtx, pid: number): Promise<void> {
  assertPositiveInt(pid, "pid");
  try {
    await ctx.deps.backend.ports.kill(pid);
  } catch {
    // Process may have already exited — ignore
  }
  // Re-scan immediately so UI updates
  const ports = await ctx.deps.portScanner.scanNow();
  // Same signal the scanner's own tick publishes (ADR-180 D5), so a kill
  // reaches every renderer rather than only the primary window.
  publishRendererBroadcast("ports", "changed", enrichPorts(ctx.deps, ports));
}

export const ports = {
  // The scanner lifecycle is what a viewer does to its own view.
  startScanner: method(portsStartScanner),
  stopScanner: method(portsStopScanner),
  updateWorkspacePaths: method(portsUpdateWorkspacePaths),
  updateWorkspaceMetadata: method(portsUpdateWorkspaceMetadata),
  scanNow: method(portsScanNow),
  // A port dying is "moves state the other viewers of this host will see".
  killPort: method(portsKillPort, { mutating: true }),
};
