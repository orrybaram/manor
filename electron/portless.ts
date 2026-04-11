/**
 * PortlessManager — wraps the portless proxy server.
 *
 * Manages a local HTTP proxy that routes requests based on the Host header,
 * mapping `.localhost` hostnames to local ports.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { createProxyServer, type RouteInfo, type ProxyServer } from "portless";

const PORT_FILE = path.join(
  process.env.HOME || "/tmp",
  ".manor",
  "portless-proxy-port",
);

const DEFAULT_PROXY_PORT = 1355;

export class PortlessManager {
  routes: RouteInfo[] = [];
  server: ProxyServer | null = null;
  proxyPort: number | null = null;

  /** Start the proxy server. Retries with incremented ports on EADDRINUSE. */
  async start(proxyPort?: number): Promise<void> {
    const startPort = proxyPort ?? DEFAULT_PROXY_PORT;
    const maxAttempts = 10;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const port = startPort + attempt;

      this.server = createProxyServer({
        proxyPort: port,
        getRoutes: () => this.routes,
      });

      // Disable Node.js default timeouts that cause proxied pages to
      // force-refresh.  headersTimeout defaults to 60 000 ms — the server
      // terminates idle keep-alive sockets after ~60 s, which Chromium
      // interprets as a connection reset and triggers a visible reload.
      // This proxy only listens on 127.0.0.1, so the timeouts add no
      // security value.
      if (this.server instanceof http.Server) {
        this.server.headersTimeout = 0;
        this.server.requestTimeout = 0;
      }

      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error) => {
            this.server = null;
            reject(err);
          };

          this.server!.once("error", onError);
          this.server!.listen(port, () => {
            this.server!.off("error", onError);
            this.proxyPort = port;
            fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true });
            fs.writeFileSync(PORT_FILE, String(port));
            resolve();
          });
        });

        if (port !== startPort) {
          console.log(
            `[portless] Port ${startPort} in use, using ${port} instead`,
          );
        }
        return;
      } catch (err: unknown) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EADDRINUSE") {
          this.server?.close();
          this.server = null;
          continue;
        }
        throw err;
      }
    }

    throw new Error(
      `[portless] Could not find a free port after trying ${startPort}–${startPort + maxAttempts - 1}`,
    );
  }

  /** Stop the proxy server. */
  stop(): void {
    this.server?.close();
    this.server = null;
    this.proxyPort = null;
    try {
      fs.unlinkSync(PORT_FILE);
    } catch {
      // File may not exist; ignore
    }
  }

  /** Restart the proxy server, preserving the current route table. */
  async restart(): Promise<void> {
    const previousRoutes = this.routes;
    const previousPort = this.proxyPort ?? undefined;
    this.stop();
    await this.start(previousPort);
    this.routes = previousRoutes;
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
