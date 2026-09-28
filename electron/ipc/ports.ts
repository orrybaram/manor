import { ipcMain } from "electron";
import type { ActivePort } from "../ports";
import { portlessManager } from "../portless";
import {
  hostSegments,
  portlessHostFor,
  portlessHostname,
} from "../../src/lib/portless-hostname";
import { remoteFormOfUrl } from "../remote-forwards";
import { LOCAL_HOST_ID } from "../backend/types";
import {
  assertHostPaths,
  assertPositiveInt,
  assertString,
  assertWorkspaceMeta,
} from "../ipc-validate";
import type { IpcDeps, WorkspaceMeta } from "./types";

export function register(deps: IpcDeps): void {
  const { portScanner, backend, backendRegistry, remoteForwards, remoteUrlResolver } = deps;

  function getMainWindow() {
    return deps.mainWindow;
  }

  // Local copy that can be reassigned when renderer sends updates
  let workspaceMeta: WorkspaceMeta[] = deps.workspaceMeta;

  /**
   * Dress the scanner's merged ports with their portless hostnames and
   * point the proxy's routes at them. Returns new objects: the scanner's
   * own results are never modified.
   */
  function enrichPorts(ports: ActivePort[]): ActivePort[] {
    const proxyPort = portlessManager.proxyPort;
    const routes: { hostname: string; port: number }[] = [];
    const segments = hostSegments(backendRegistry.remoteHostIds());
    const enriched = ports.map((port) => {
      // By host and path: a local and a remote workspace can share a path
      // (ADR-191).
      const meta = workspaceMeta.find(
        (m) => m.path === port.workspacePath && m.hostId === port.hostId,
      );
      // portlessEnabled === false opts the project out — its ports keep the
      // plain `localhost:<port>` URL and contribute no proxy route.
      if (!meta || !proxyPort || meta.portlessEnabled === false) return port;
      const host = portlessHostFor(port.hostId, segments);
      if (host.kind === "unknown") return port;
      const hostname = portlessHostname(meta, host);
      // A remote port is only reachable through its forward: the route
      // exists once the port has been opened (see `ports:resolveUrl`).
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
  portScanner.setEnricher(enrichPorts);

  // A forward appearing or going away changes where portless routes point.
  remoteForwards.onChange(() => {
    portScanner.refresh();
  });

  ipcMain.handle("ports:startScanner", () => {
    portScanner.start(getMainWindow()!);
  });

  ipcMain.handle("ports:stopScanner", () => {
    portScanner.stop();
  });

  // Workspaces arrive with their project's host (ADR-183).
  ipcMain.handle("ports:updateWorkspaces", (_event, workspaces: unknown) => {
    assertHostPaths(workspaces, "workspaces");
    portScanner.updateWorkspaces(workspaces);
  });

  ipcMain.handle(
    "ports:updateWorkspaceMetadata",
    (_event, meta: unknown) => {
      assertWorkspaceMeta(meta, "meta");
      workspaceMeta = meta;
    },
  );

  ipcMain.handle("ports:scanNow", () => portScanner.scanNow());

  // ── Resolving URLs opened in a remote host's context ──
  //
  // `remoteUrlResolver` is built once in app-lifecycle.ts, alongside
  // `paneHosts`, so `ControlDeps.resolvePaneUrl` (an agent's `navigate` in a
  // remote pane) uses the very same instance without waiting for this
  // module to register (ADR-183).

  ipcMain.handle(
    "ports:resolveUrl",
    async (_event, url: string, hostId: string): Promise<string> => {
      assertString(url, "url");
      assertString(hostId, "hostId");
      return remoteUrlResolver.resolve(url, hostId);
    },
  );

  /**
   * The URL a remote pane remembers and shows for `url`, the one it loaded:
   * `localhost:<remote port>` for a URL on one of `hostId`'s forwards (now
   * or earlier), which means something after a restart; `url` otherwise.
   */
  ipcMain.handle(
    "ports:remoteUrl",
    (_event, url: string, hostId: string): string => {
      assertString(url, "url");
      assertString(hostId, "hostId");
      if (hostId === LOCAL_HOST_ID) return url;
      return remoteFormOfUrl(url, (localPort) =>
        remoteForwards.remotePortFor(hostId, localPort),
      );
    },
  );

  ipcMain.handle("ports:killPort", async (_event, pid: number) => {
    assertPositiveInt(pid, "pid");
    try {
      await backend.ports.kill(pid);
    } catch {
      // Process may have already exited — ignore
    }
    // Re-scan immediately so UI updates
    const ports = await portScanner.scanNow();
    getMainWindow()?.webContents.send("ports-changed", ports);
  });
}
