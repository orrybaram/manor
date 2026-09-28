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
import { portlessProxyPortFile } from "./paths";
import { LOCAL_HOST_ID } from "./backend/types";

const PORT_FILE = portlessProxyPortFile();

const DEFAULT_PROXY_PORT = 1355;

/**
 * DNS-label-safes a slug: lowercase, non-alphanumeric runs become one
 * hyphen, no leading or trailing hyphen, capped at 63 chars (the DNS label
 * limit). Shared by the project slug and, since ADR-191 §6, the host
 * segment's full-id fallback.
 */
function sanitizeLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

/**
 * The `.localhost` label naming a non-local host, or `null` for local —
 * whose hostnames carry no host segment, unchanged since before this existed
 * (ADR-191 §6). A local main and a remote main of the same project used to
 * both claim `project.localhost`; this tells them apart.
 *
 * The label is the first 8 characters of the host id, lowercased: short,
 * and stable since a host id never changes. It falls back to the full
 * (sanitized) id only when that prefix collides with another host's among
 * `knownHostIds` — the hosts portless currently knows about — so two hosts
 * are never routed to the same hostname. The id, not the host's name (the
 * ssh target): a name can be edited, which would silently move every
 * bookmarked URL, and two hosts can share a name, which is the very
 * collision this guards against.
 */
export function hostSegment(
  hostId: string,
  knownHostIds: readonly string[],
): string | null {
  if (hostId === LOCAL_HOST_ID) return null;
  const short = hostId.slice(0, 8).toLowerCase();
  const collides = knownHostIds.some(
    (other) =>
      other !== hostId &&
      other !== LOCAL_HOST_ID &&
      other.slice(0, 8).toLowerCase() === short,
  );
  return collides ? sanitizeLabel(hostId) : short;
}

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
   * If `branch` is set and `!isMain`, the base is `${branch}.${base}`.
   * `hostSeg` — this workspace's host segment (`hostSegment`, ADR-191 §6),
   * `null` for local — inserts a further `.${hostSeg}` right before
   * `.localhost`, so a local and a remote checkout of the same project
   * never claim the same hostname.
   */
  hostnameForPort(
    workspacePath: string,
    projectName: string | undefined | null,
    branch: string | undefined | null,
    isMain: boolean,
    hostSeg?: string | null,
  ): string {
    const rawBase = projectName || path.basename(workspacePath);
    const base = sanitizeLabel(rawBase);
    const withBranch =
      branch && !isMain ? `${sanitizeLabel(branch)}.${base}` : base;
    const suffix = hostSeg ? `.${hostSeg}` : "";

    return `${withBranch}${suffix}.localhost`;
  }
}

export const portlessManager = new PortlessManager();
