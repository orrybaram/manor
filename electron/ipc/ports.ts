import { ipcMain } from "electron";
import type { ActivePort } from "../ports";
import { portlessManager } from "../portless";
import { resolveRemotePortUrl } from "../remote-forwards";
import { LOCAL_HOST_ID } from "../backend/types";
import {
  assertPositiveInt,
  assertString,
  assertStringArray,
} from "../ipc-validate";
import type { IpcDeps, WorkspaceMeta } from "./types";

export function register(deps: IpcDeps): void {
  const { portScanner, backend, remoteForwards } = deps;

  function getMainWindow() {
    return deps.mainWindow;
  }

  // Local copy that can be reassigned when renderer sends updates
  let workspaceMeta: WorkspaceMeta[] = deps.workspaceMeta;
  /** The latest enriched scan, for resolving URLs of remote ports. */
  let latestPorts: ActivePort[] = [];

  function enrichPorts(ports: ActivePort[]): ActivePort[] {
    const proxyPort = portlessManager.proxyPort;
    const routes: { hostname: string; port: number }[] = [];
    for (const port of ports) {
      const provider = port.hostId
        ? deps.backendRegistry.provider(port.hostId)
        : undefined;
      if (provider?.capabilities.previewUrls && provider.previewUrl) {
        port.canCopyPublicUrl = true;
      } else {
        delete port.canCopyPublicUrl;
      }
      const meta = workspaceMeta.find((m) => m.path === port.workspacePath);
      // portlessEnabled === false opts the project out — its ports keep the
      // plain `localhost:<port>` URL and contribute no proxy route.
      if (meta && proxyPort && meta.portlessEnabled !== false) {
        const hostname = portlessManager.hostnameForPort(
          meta.path,
          meta.projectName,
          meta.branch,
          meta.isMain,
        );
        // A remote port is only reachable through its forward: the route
        // exists once the port has been opened (see `ports:resolveUrl`).
        const target = port.hostId
          ? remoteForwards.localPort(port.hostId, port.port)
          : port.port;
        if (target !== undefined) routes.push({ hostname, port: target });
        // Include proxy port in hostname so renderer can build correct URLs
        port.hostname = `${hostname}:${proxyPort}`;
      }
    }
    portlessManager.updateRoutes(routes);
    latestPorts = ports;
    return ports;
  }

  // A forward appearing or going away changes where portless routes point.
  remoteForwards.onChange(() => {
    enrichPorts(latestPorts);
  });

  ipcMain.handle("ports:startScanner", () => {
    portScanner.start(getMainWindow()!, enrichPorts);
  });

  ipcMain.handle("ports:stopScanner", () => {
    portScanner.stop();
  });

  ipcMain.handle("ports:updateWorkspacePaths", (_event, paths: string[]) => {
    assertStringArray(paths, "paths");
    portScanner.updateWorkspacePaths(paths);
  });

  ipcMain.handle(
    "ports:updateWorkspaceMetadata",
    (_event, meta: WorkspaceMeta[]) => {
      workspaceMeta = meta;
    },
  );

  ipcMain.handle("ports:scanNow", async () => {
    const ports = await portScanner.scanNow();
    return enrichPorts(ports);
  });

  /**
   * The URL to actually load for `url`, opened in the context of `hostId` —
   * a port's host (the port list) or the host of the workspace the opening
   * browser pane belongs to. For a remote host, a `localhost:<port>` URL
   * whose port that host's latest scan reports goes through a port forward
   * (ADR-178 §5); every other URL — including a loopback port the scan did
   * not report, which may well be a server on this machine — and every URL
   * on this machine is returned as is. So is a URL whose forward cannot be
   * made (e.g. the host is not connected).
   */
  ipcMain.handle(
    "ports:resolveUrl",
    async (_event, url: string, hostId: string): Promise<string> => {
      assertString(url, "url");
      assertString(hostId, "hostId");
      if (hostId === LOCAL_HOST_ID) return url;
      const remotePorts = latestPorts.filter((p) => p.hostId === hostId);
      try {
        return await resolveRemotePortUrl(url, remotePorts, (port) =>
          remoteForwards.ensure(hostId, port),
        );
      } catch (err) {
        console.warn(
          `[ports] forwarding ${url} from ${hostId} failed:`,
          err instanceof Error ? err.message : err,
        );
        return url;
      }
    },
  );

  /** A public URL for a remote port, where its host's provider offers one. */
  ipcMain.handle(
    "ports:publicUrl",
    async (_event, hostId: string, port: number): Promise<string | null> => {
      assertString(hostId, "hostId");
      assertPositiveInt(port, "port");
      const provider = deps.backendRegistry.provider(hostId);
      if (!provider?.capabilities.previewUrls || !provider.previewUrl) return null;
      return provider.previewUrl(port);
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
    const enriched = enrichPorts(ports);
    getMainWindow()?.webContents.send("ports-changed", enriched);
  });
}
