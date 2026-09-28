/**
 * RpcChannel — the request/response half of the daemon protocol, over the
 * control socket: NDJSON framing, request ids, the ordering mutex, timeouts,
 * and checking each reply is one its request can get.
 */

import type { Duplex } from "node:stream";
import type {
  ControlRequest,
  ControlResponse,
  Envelope,
  ResponseFor,
  SuccessFor,
} from "./types";
import { REPLY_TYPES } from "./types";

/** Per-request timeout for control requests that do not name their own. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Request types the daemon answers out of order (see `callConcurrent`). */
type ConcurrentRequest = Extract<
  ControlRequest,
  { type: "exec" | "readFile" | "writeFile" }
>;

interface PendingRequest {
  resolve: (resp: ControlResponse) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout> | undefined;
}

/** Call `onLine` with every complete, non-blank line `socket` reads. */
export function readLines(socket: Duplex, onLine: (line: string) => void): void {
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (line.trim()) onLine(line);
    }
  });
}

/**
 * `resp` as a successful reply to a `type` request. Throws the daemon's
 * message on an `error` reply, and on a reply the request cannot get.
 */
function expectSuccess<K extends ControlRequest["type"]>(
  type: K,
  resp: ResponseFor<K>,
): SuccessFor<K> {
  const reply = resp as ControlResponse;
  if (reply.type === "error") throw new Error(reply.message);
  const expected: readonly string[] = REPLY_TYPES[type];
  if (!expected.includes(reply.type)) {
    throw new Error(`unexpected ${reply.type} reply to ${type}`);
  }
  return resp as SuccessFor<K>;
}

export class RpcChannel {
  private socket: Duplex | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private requestIdCounter = 0;
  /** Serializes ordinary requests so only one is in flight at a time —
   *  terminal operations depend on the daemon seeing them in order.
   *  `exec`/`readFile`/`writeFile` bypass it (see `callConcurrent`); replies
   *  are matched by `requestId`, so they may arrive in any order. */
  private mutex: Promise<void> = Promise.resolve();

  /**
   * `onTimeout` runs after a request times out, with the request's type. A
   * daemon that stops answering is presumed gone, so the owner tears the
   * connection down.
   */
  constructor(private readonly onTimeout: (type: string) => void) {}

  /** Send requests over `socket` from now on. Replies on any other are dropped. */
  attach(socket: Duplex): void {
    this.socket = socket;
    readLines(socket, (line) => {
      if (socket !== this.socket) return;
      let reply: Partial<Envelope<ControlResponse>>;
      try {
        reply = JSON.parse(line);
      } catch {
        return; // invalid JSON, skip
      }
      this.dispatch(reply);
    });
  }

  /** Whether `socket` is the one requests go out on. */
  owns(socket: Duplex): boolean {
    return socket === this.socket;
  }

  /**
   * Destroy the socket and fail every pending request, so stale state cannot
   * leak into the next connection.
   */
  close(): void {
    this.socket?.destroy();
    this.socket = null;
    this.mutex = Promise.resolve();
    for (const [, req] of this.pending) {
      if (req.timeout) clearTimeout(req.timeout);
      req.reject(new Error("Disconnected"));
    }
    this.pending.clear();
  }

  /**
   * Send `req` in order behind every earlier request and resolve with its
   * successful reply. Rejects on an `error` reply, a reply of the wrong type,
   * a timeout or a disconnect.
   */
  async call<R extends ControlRequest>(
    req: R,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<SuccessFor<R["type"]>> {
    return expectSuccess<R["type"]>(req.type, await this.request(req, timeoutMs));
  }

  /**
   * `call` without queueing behind the mutex. Only for request types the
   * daemon answers out of order (`exec`, `readFile`, `writeFile`); anything
   * else relies on the daemon seeing requests in order. `timeoutMs: null`
   * waits until the reply or a disconnect.
   */
  async callConcurrent<R extends ConcurrentRequest>(
    req: R,
    timeoutMs: number | null,
  ): Promise<SuccessFor<R["type"]>> {
    return expectSuccess<R["type"]>(req.type, await this.send(req, timeoutMs));
  }

  /** `call`, but resolving with an `error` reply instead of throwing it. */
  request<R extends ControlRequest>(
    req: R,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<ResponseFor<R["type"]>> {
    const result = this.mutex.then(() => this.send(req, timeoutMs));
    this.mutex = result.then(() => {}, () => {});
    return result;
  }

  private send<R extends ControlRequest>(
    req: R,
    timeoutMs: number | null,
  ): Promise<ResponseFor<R["type"]>> {
    return new Promise<ControlResponse>((resolve, reject) => {
      if (!this.socket?.writable) {
        reject(new Error("Control socket not writable"));
        return;
      }

      const requestId = String(++this.requestIdCounter);

      const timeout =
        timeoutMs === null
          ? undefined
          : setTimeout(() => {
              this.pending.delete(requestId);
              reject(new Error(`Request timed out: ${req.type}`));
              this.onTimeout(req.type);
            }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timeout });
      const envelope: Envelope<R> = { ...req, requestId };
      this.socket.write(JSON.stringify(envelope) + "\n");
      // The daemon answers a request of type `R` with `ResponseFor<R>`.
    }) as Promise<ResponseFor<R["type"]>>;
  }

  /**
   * Hand a reply to the request it answers, matched by `requestId`
   * (exec/readFile/writeFile replies can overtake others). A reply to a
   * request that already timed out is dropped. A reply without an id — the
   * daemon could not read one out of a garbled line — could answer any
   * pending request, so every one of them fails rather than one getting the
   * wrong answer.
   */
  private dispatch(resp: Partial<Envelope<ControlResponse>>): void {
    if (resp.requestId === undefined) {
      const detail = resp.type === "error" ? resp.message : `a ${resp.type} reply`;
      for (const [id, pending] of [...this.pending]) {
        this.pending.delete(id);
        if (pending.timeout) clearTimeout(pending.timeout);
        pending.reject(new Error(`Daemon reply without a requestId: ${detail}`));
      }
      return;
    }
    const pending = this.pending.get(resp.requestId);
    if (!pending) return;
    this.pending.delete(resp.requestId);
    if (pending.timeout) clearTimeout(pending.timeout);
    const { requestId: _requestId, ...reply } = resp;
    pending.resolve(reply as ControlResponse);
  }
}
