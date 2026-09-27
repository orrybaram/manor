/**
 * StreamChannel — the stream socket half of the daemon protocol:
 * fire-and-forget commands out, NDJSON events in, fanned out to every
 * subscriber.
 */

import type { Duplex } from "node:stream";
import { readLines } from "./rpc-channel";
import type { StreamCommand, StreamEvent } from "./types";

export type StreamEventHandler = (event: StreamEvent) => void;

export class StreamChannel {
  private socket: Duplex | null = null;
  private readonly handlers = new Set<StreamEventHandler>();

  /**
   * `intercept` sees each event first and returns true for one it consumed
   * (exec stream events), which then reaches no subscriber.
   */
  constructor(private readonly intercept: (event: StreamEvent) => boolean) {}

  /** Identify `socket` to the daemon as a stream connection and read from it. */
  attach(socket: Duplex, token: string): void {
    this.socket = socket;
    socket.write(JSON.stringify({ connectionType: "stream", token }) + "\n");
    readLines(socket, (line) => {
      let event: StreamEvent;
      try {
        event = JSON.parse(line) as StreamEvent;
      } catch {
        return; // invalid JSON, skip
      }
      try {
        if (!this.intercept(event)) this.emit(event);
      } catch (err) {
        console.error("[terminal-host] exec stream callback threw:", err);
      }
    });
  }

  /** Whether `socket` is the current stream socket. */
  owns(socket: Duplex): boolean {
    return socket === this.socket;
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  /** Send `cmd`; false (and nothing sent) when the socket is not writable. */
  write(cmd: StreamCommand): boolean {
    if (!this.socket?.writable) return false;
    this.socket.write(JSON.stringify(cmd) + "\n");
    return true;
  }

  /** Subscribe to stream events. Returns an unsubscribe. */
  subscribe(handler: StreamEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Deliver `event` to every subscriber; one that throws does not stop the rest. */
  emit(event: StreamEvent): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(event);
      } catch (err) {
        console.error(`[terminal-host] ${event.type} handler threw:`, err);
      }
    }
  }
}
