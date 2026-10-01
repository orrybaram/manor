import type { ActivePort } from "../../ports";
import { portlessManager } from "../../portless";
import {
  hostSegments,
  portlessHostFor,
  portlessHostname,
} from "../../../src/lib/portless-hostname";
import { remoteFormOfUrl } from "../../remote-forwards";
import { LOCAL_HOST_ID } from "../../backend/types";
import {
  assertHostPaths,
  assertPositiveInt,
  assertString,
  assertWorkspaceMeta,
} from "../../ipc-validate";
import { publishRendererBroadcast } from "../../renderer-broadcast";
import type { HostDeps, WorkspaceMeta } from "../../ipc/types";
import type { HostPath } from "../../per-host-poller";
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

/**
 * Dress the scanner's merged ports with their portless hostnames and point
 * the proxy's routes at them. Returns new objects: the scanner's own results
 * are never modified.
 */
function enrichPorts(deps: HostDeps, ports: ActivePort[]): ActivePort[] {
  const { backendRegistry, remoteForwards } = deps;
  const proxyPort = portlessManager.proxyPort;
  const routes: { hostname: string; port: number }[] = [];
  const segments = hostSegments(backendRegistry.remoteHostIds());
  const enriched = ports.map((port) => {
    // By host and path: a local and a remote workspace can share a path
    // (ADR-191).
    const meta = deps.workspaceMeta.find(
      (m) => m.path === port.workspacePath && m.hostId === port.hostId,
    );
    // portlessEnabled === false opts the project out — its ports keep the
    // plain `localhost:<port>` URL and contribute no proxy route.
    if (!meta || !proxyPort || meta.portlessEnabled === false) return port;
    const host = portlessHostFor(port.hostId, segments);
    if (host.kind === "unknown") return port;
    const hostname = portlessHostname(meta, host);
    // A remote port is only reachable through its forward: the route
    // exists once the port has been opened (see `portsResolveUrl`).
    const target =
      host.kind === "local"
        ? port.port
        : remoteForwards.localPort(port.hostId, port.port);
    if (target !== undefined) routes.push({ hostname, port: target });
    // Include proxy port in hostname so renderer can build correct URLs
    return { ...port, hostname: `${hostname}:${proxyPort}` };
  });
  portlessManager.updateRoutes(routes);
  return enriched;
}

/**
 * Hand the scanner its enricher, once, at startup (`app-lifecycle.ts`).
 *
 * This was the body of `ipc/ports.ts`'s `register()` before the table took
 * over its handlers: the scanner dresses every merged result itself, so a
 * port reaches every renderer already enriched, and a forward appearing or
 * going away re-dresses the latest ports because it changes where portless
 * routes point.
 */
export function installPortEnricher(deps: HostDeps): void {
  deps.portScanner.setEnricher((ports) => enrichPorts(deps, ports));
  deps.remoteForwards.onChange(() => {
    deps.portScanner.refresh();
  });
}

export function portsStartScanner(ctx: HandlerCtx): void {
  ctx.deps.portScanner.start();
}

export function portsStopScanner(ctx: HandlerCtx): void {
  ctx.deps.portScanner.stop();
}

/** Every open workspace, with its project's host (ADR-183). */
export function portsUpdateWorkspaces(
  ctx: HandlerCtx,
  workspaces: readonly HostPath[],
): void {
  const value: unknown = workspaces;
  assertHostPaths(value, "workspaces");
  ctx.deps.portScanner.updateWorkspaces(value);
}

export function portsUpdateWorkspaceMetadata(
  ctx: HandlerCtx,
  meta: WorkspaceMeta[],
): void {
  const value: unknown = meta;
  assertWorkspaceMeta(value, "meta");
  ctx.deps.workspaceMeta = value;
}

export function portsScanNow(ctx: HandlerCtx): Promise<ActivePort[]> {
  return ctx.deps.portScanner.scanNow();
}

/**
 * The URL to load for `url` opened in `hostId`'s context: a remote host's
 * `localhost:<port>` becomes its forwarded local port (ADR-178 §5).
 *
 * `remoteUrlResolver` is built once in app-lifecycle.ts, alongside
 * `paneHosts`, so `RouteDeps.resolvePaneUrl` (an agent's `navigate` in a
 * remote pane) uses the very same instance (ADR-183).
 */
export function portsResolveUrl(
  ctx: HandlerCtx,
  url: string,
  hostId: string,
): Promise<string> {
  assertString(url, "url");
  assertString(hostId, "hostId");
  return ctx.deps.remoteUrlResolver.resolve(url, hostId);
}

/**
 * The URL a remote pane remembers and shows for `url`, the one it loaded:
 * `localhost:<remote port>` for a URL on one of `hostId`'s forwards (now or
 * earlier), which means something after a restart; `url` otherwise.
 */
export function portsRemoteUrl(
  ctx: HandlerCtx,
  url: string,
  hostId: string,
): string {
  const { deps } = ctx;
  assertString(url, "url");
  assertString(hostId, "hostId");
  if (hostId === LOCAL_HOST_ID) return url;
  return remoteFormOfUrl(url, (localPort) =>
    deps.remoteForwards.remotePortFor(hostId, localPort),
  );
}

/**
 * `pid` is `MUTATING` (ADR-180 D4) — it ends a process the whole host can
 * see, the same "moves state the other viewers of this host will see" line
 * that put `projects.remove` there.
 */
export async function portsKillPort(
  ctx: HandlerCtx,
  pid: number,
): Promise<void> {
  const { deps } = ctx;
  assertPositiveInt(pid, "pid");
  try {
    await deps.backend.ports.kill(pid);
  } catch {
    // Process may have already exited — ignore
  }
  // Re-scan immediately so UI updates. Same signal the scanner's own tick
  // publishes (ADR-180 D5), so a kill reaches every renderer rather than
  // only the primary window.
  const ports = await deps.portScanner.scanNow();
  publishRendererBroadcast("ports", "changed", ports);
}

export const ports = {
  // The scanner lifecycle is what a viewer does to its own view.
  startScanner: method(portsStartScanner),
  stopScanner: method(portsStopScanner),
  updateWorkspaces: method(portsUpdateWorkspaces),
  updateWorkspaceMetadata: method(portsUpdateWorkspaceMetadata),
  scanNow: method(portsScanNow),
  // The two URL translations for a remote host's dev servers (ADR-178 §5).
  // Reads: a forward is opened on *this* machine either way, so a browser
  // asking gets the URL the host would load — which a device can only reach
  // if it reaches the host's loopback too. Not `localOnly`; the answer is
  // harmless, and the web app's webview panes are absent anyway.
  resolveUrl: method(portsResolveUrl),
  remoteUrl: method(portsRemoteUrl),
  // A port dying is "moves state the other viewers of this host will see".
  killPort: method(portsKillPort, { mutating: true }),
};
