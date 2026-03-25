/**
 * PortlessManager — wraps the portless proxy server.
 *
 * Manages a local HTTP proxy that routes requests based on the Host header,
 * mapping `.localhost` hostnames to local ports.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { createProxyServer, type RouteInfo, type ProxyServer } from "portless";

const PORT_FILE = path.join(
  process.env.HOME || "/tmp",
  ".manor",
  "portless-proxy-port",
);

const DEFAULT_PROXY_PORT = 1355;

/** Find a free TCP port by binding to port 0 and reading the assigned port. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : null;
      server.close((err) => {
        if (err) reject(err);
        else if (port == null) reject(new Error("Could not determine free port"));
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

/** Check if a TCP port is already in use on localhost. */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    server.listen(port, "127.0.0.1");
  });
}

export class PortlessManager {
  routes: RouteInfo[] = [];
  server: ProxyServer | null = null;

  /** Start the proxy server. Falls back to a random free port if 1355 is in use. */
  async start(proxyPort?: number): Promise<void> {
    let port = proxyPort ?? DEFAULT_PROXY_PORT;

    if (await isPortInUse(port)) {
      port = await findFreePort();
    }

    this.server = createProxyServer({
      proxyPort: port,
      getRoutes: () => this.routes,
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server = null;
        reject(err);
      };

      this.server!.once("error", onError);
      this.server!.listen(port, () => {
        this.server!.off("error", onError);
        fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true });
        fs.writeFileSync(PORT_FILE, String(port));
        resolve();
      });
    });
  }

  /** Stop the proxy server. */
  stop(): void {
    this.server?.close();
    this.server = null;
    try {
      fs.unlinkSync(PORT_FILE);
    } catch {
      // File may not exist; ignore
    }
  }

  /**
   * Replace the current route table.
   * No proxy reload needed — portless calls `getRoutes()` on every request.
   */
  updateRoutes(routes: RouteInfo[]): void {
    this.routes = routes;
  }

  /**
   * Compute the `.localhost` hostname for a given project.
   *
   * Base slug: `projectName` or `basename(workspacePath)`, sanitized
   * (lowercase, non-alphanumeric → hyphens, max 63 chars).
   *
   * If `branch` is set and `!isMain`, returns `${branch}.${base}.localhost`.
   * Otherwise returns `${base}.localhost`.
   */
  hostnameForPort(
    workspacePath: string,
    projectName: string | undefined | null,
    branch: string | undefined | null,
    isMain: boolean,
  ): string {
    const sanitize = (s: string): string =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 63);

    const rawBase = projectName || path.basename(workspacePath);
    const base = sanitize(rawBase);

    if (branch && !isMain) {
      return `${sanitize(branch)}.${base}.localhost`;
    }

    return `${base}.localhost`;
  }
}

export const portlessManager = new PortlessManager();
