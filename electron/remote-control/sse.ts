/**
 * Server-Sent Events fan-out for the remote-control listener (ADR-161 §5).
 *
 * SSE rather than WebSocket because the traffic is one-directional status
 * push: the browser's `EventSource` reconnects on its own, it survives the
 * proxies a tunnel puts in the path, and it is a few dozen lines instead of a
 * protocol.
 *
 * Two things this file exists to get right: a heartbeat, because an idle
 * tunnel will close a silent connection; and disconnect cleanup, because a
 * phone that goes to sleep leaves a socket behind and a leaked one keeps the
 * whole `ServerResponse` — and any closure it captured — alive.
 */

import type { ServerResponse } from "node:http";

/** Idle proxies drop quiet connections; a comment line is the cheapest keepalive. */
const HEARTBEAT_MS = 20_000;

export interface SseClient {
  /** Device id, for logging. Never a token. */
  deviceId: string;
  res: ServerResponse;
}

export class SseHub {
  private clients = new Set<SseClient>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  get size(): number {
    return this.clients.size;
  }

  /**
   * Adopt an authenticated request's response as a stream. Writes the SSE
   * headers, so the caller must not have written any of its own.
   */
  add(deviceId: string, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disables buffering in the proxies a tunnel is likely to put in front.
      "X-Accel-Buffering": "no",
    });
    // Some proxies hold the response until the first bytes arrive.
    res.write(": connected\n\n");

    const client: SseClient = { deviceId, res };
    this.clients.add(client);

    const drop = () => this.drop(client);
    res.on("close", drop);
    res.on("error", drop);

    this.ensureHeartbeat();
  }

  /** Send one named event to every live client. */
  broadcast(event: string, data: unknown): void {
    if (this.clients.size === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of [...this.clients]) {
      try {
        client.res.write(payload);
      } catch {
        this.drop(client);
      }
    }
  }

  /** End every stream — `stop()` is not done until the sockets are closed. */
  closeAll(): void {
    for (const client of [...this.clients]) {
      try {
        client.res.end();
      } catch {
        // Already gone.
      }
      this.clients.delete(client);
    }
    this.stopHeartbeat();
  }

  private drop(client: SseClient): void {
    if (!this.clients.delete(client)) return;
    if (this.clients.size === 0) this.stopHeartbeat();
  }

  /** Runs only while someone is listening, so an idle app has no timer. */
  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const client of [...this.clients]) {
        try {
          client.res.write(": ping\n\n");
        } catch {
          this.drop(client);
        }
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
