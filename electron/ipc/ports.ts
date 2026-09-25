import { ipcMain } from "electron";
import type { ActivePort } from "../ports";
import { portlessManager } from "../portless";
import {
  isRemoteCandidateUrl,
  remoteFormOfUrl,
  remotePortUnknown,
  resolveRemotePortUrl,
} from "../remote-forwards";
import { LOCAL_HOST_ID } from "../backend/types";
import {
  assertPositiveInt,
  assertString,
  assertStringArray,
} from "../ipc-validate";
import type { IpcDeps, WorkspaceMeta } from "./types";

/** How long an agent's `navigate` waits for a remote host to come back. */
const NAVIGATE_HOST_WAIT_MS = 15_000;

export function register(deps: IpcDeps): void {
  const { portScanner, backend, remoteForwards, backendRegistry } = deps;

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

  // ── Resolving URLs opened in a remote host's context ──

  /**
   * A remote host is ready to resolve URLs against once it is connected and
   * has been scanned — before that its ports are unknown, and a
   * `localhost:<port>` URL cannot be told apart from one on this machine.
   */
  function hostReadiness(hostId: string): "ready" | "gone" | "waiting" {
    const status = backendRegistry.status(hostId);
    if (status === undefined) return "gone";
    return status === "connected" && portScanner.hasScanned(hostId) ? "ready" : "waiting";
  }

  const readinessWaiters = new Set<() => void>();
  const pokeWaiters = () => {
    for (const waiter of Array.from(readinessWaiters)) waiter();
  };
  portScanner.onHostScanned(pokeWaiters);
  backendRegistry.onStatusChange(pokeWaiters);

  /** Resolves once `hostId` is ready, is unregistered, or `timeoutMs` passes. */
  function whenHostReady(
    hostId: string,
    timeoutMs?: number,
  ): Promise<"ready" | "gone" | "timeout"> {
    const now = hostReadiness(hostId);
    if (now !== "waiting") return Promise.resolve(now);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (result: "ready" | "gone" | "timeout") => {
        if (timer) clearTimeout(timer);
        readinessWaiters.delete(waiter);
        resolve(result);
      };
      const waiter = () => {
        const state = hostReadiness(hostId);
        if (state !== "waiting") settle(state);
      };
      readinessWaiters.add(waiter);
      if (timeoutMs !== undefined) timer = setTimeout(() => settle("timeout"), timeoutMs);
    });
  }

  /**
   * The URL to actually load for `url`, opened in the context of `hostId` —
   * a port's host (the port list) or the host of the workspace the opening
   * browser pane belongs to. For a remote host, a `localhost:<port>` URL
   * whose port that host's latest scan reports goes through a port forward
   * (ADR-178 §5), as does one still holding an old forward's local port;
   * every other URL — including a loopback port the scan did not report,
   * which may well be a server on this machine — and every URL on this
   * machine is returned as is. So is a URL whose forward cannot be made
   * while the host is connected.
   *
   * A loopback URL waits for the host to be connected and scanned (a pane
   * restored at startup, or during a reconnect); with `timeoutMs` it
   * rejects if that takes longer. A host that is unregistered meanwhile
   * gets the URL back as is.
   */
  async function resolveForHost(
    url: string,
    hostId: string,
    timeoutMs?: number,
  ): Promise<string> {
    if (hostId === LOCAL_HOST_ID || !isRemoteCandidateUrl(url)) return url;
    let rescanned = false;
    for (;;) {
      const state = await whenHostReady(hostId, timeoutMs);
      if (state === "gone") return url;
      if (state === "timeout") {
        throw new Error(`Remote host "${hostId}" is not connected`);
      }
      let remotePorts = latestPorts.filter((p) => p.hostId === hostId);
      // A port the last poll did not see may be a dev server that started
      // since (an agent navigating right after launching it). Scan the host
      // once, now, before deciding the URL means this machine.
      if (
        !rescanned &&
        remotePortUnknown(url, remotePorts, (localPort) =>
          remoteForwards.remotePortFor(hostId, localPort),
        )
      ) {
        rescanned = true;
        const fresh = await portScanner.scanHost(hostId);
        if (fresh) {
          enrichPorts(fresh);
          remotePorts = latestPorts.filter((p) => p.hostId === hostId);
        }
      }
      try {
        return await resolveRemotePortUrl(
          url,
          remotePorts,
          (port, scanned) =>
            remoteForwards.ensure(
              hostId,
              port,
              scanned ? { remoteHost: scanned.loopbackHost } : undefined,
            ),
          (localPort) => remoteForwards.remotePortFor(hostId, localPort),
        );
      } catch (err) {
        // The host dropped between becoming ready and the forward: wait for
        // it to come back rather than load the URL on this machine.
        if (backendRegistry.status(hostId) !== "connected") continue;
        console.warn(
          `[ports] forwarding ${url} from ${hostId} failed:`,
          err instanceof Error ? err.message : err,
        );
        return url;
      }
    }
  }

  ipcMain.handle(
    "ports:resolveUrl",
    async (_event, url: string, hostId: string): Promise<string> => {
      assertString(url, "url");
      assertString(hostId, "hostId");
      return resolveForHost(url, hostId);
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

  // An agent's `navigate` in a remote pane goes through the same rewrite,
  // but gives up (503) rather than wait forever on an absent host.
  deps.webviewServer.setRemoteUrlResolver((url, hostId) =>
    resolveForHost(url, hostId, NAVIGATE_HOST_WAIT_MS),
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
