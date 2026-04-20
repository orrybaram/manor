import { ipcMain } from "electron";
import type { ActivePort } from "../ports";
import { portlessManager } from "../portless";
import { assertPositiveInt, assertStringArray } from "../ipc-validate";
import type { IpcDeps, WorkspaceMeta } from "./types";

export function register(deps: IpcDeps): void {
  const { portScanner, backend } = deps;

  function getMainWindow() {
    return deps.mainWindow;
  }

  // Local copy that can be reassigned when renderer sends updates
  let workspaceMeta: WorkspaceMeta[] = deps.workspaceMeta;

  function enrichPorts(ports: ActivePort[]): ActivePort[] {
    const proxyPort = portlessManager.proxyPort;
    const routes: { hostname: string; port: number }[] = [];
    for (const port of ports) {
      const meta = workspaceMeta.find((m) => m.path === port.workspacePath);
      if (meta && proxyPort) {
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
