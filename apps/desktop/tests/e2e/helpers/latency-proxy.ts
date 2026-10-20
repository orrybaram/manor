import net from "net";

/**
 * A TCP proxy that holds every chunk for half a round trip each way — the
 * one throttle that reaches a WebSocket. Chromium's network emulation delays
 * HTTP but not WebSocket frames, and on the relay the WebSocket is where a
 * phone spends its time: every bridge call is a round trip through it.
 *
 * Order is kept per direction: a chunk is released no earlier than the one
 * before it.
 */
export interface LatencyProxy {
  /** `http://127.0.0.1:<port>`: the upstream's address, slowed down. */
  readonly url: string;
  /** Cut every open connection, as a phone losing its network does. */
  dropAll(): void;
  /** Refuse new connections (and cut open ones) until `restore`. */
  outage(): void;
  restore(): void;
  close(): Promise<void>;
}

export async function startLatencyProxy(
  upstream: string,
  rttMs: number,
): Promise<LatencyProxy> {
  const target = new URL(upstream);
  const oneWay = rttMs / 2;
  const sockets = new Set<net.Socket>();

  /**
   * One ordered queue per direction, drained by one timer. (A timer per
   * chunk is not enough: Node does not order two timers due at the same
   * instant if they were created with different delays, and a reordered
   * chunk is a corrupt response.)
   */
  const pipeDelayed = (from: net.Socket, to: net.Socket) => {
    const queue: { at: number; chunk: Buffer | null }[] = [];
    let timer: NodeJS.Timeout | null = null;
    const pump = () => {
      timer = null;
      const now = Date.now();
      while (queue.length > 0 && queue[0].at <= now) {
        const { chunk } = queue.shift()!;
        if (to.destroyed) return;
        if (chunk === null) to.end();
        else to.write(chunk);
      }
      if (queue.length > 0) timer = setTimeout(pump, queue[0].at - now);
    };
    const push = (chunk: Buffer | null) => {
      queue.push({ at: Date.now() + oneWay, chunk });
      if (!timer) timer = setTimeout(pump, oneWay);
    };
    from.on("data", (chunk: Buffer) => push(chunk));
    // `end` travels the same queue, so it can never overtake a chunk.
    from.on("end", () => push(null));
  };

  let down = false;
  const server = net.createServer((client) => {
    if (down) {
      client.destroy();
      return;
    }
    const remote = net.connect(Number(target.port), target.hostname);
    sockets.add(client).add(remote);
    pipeDelayed(client, remote);
    pipeDelayed(remote, client);
    // A clean close travels as `end` (above), after whatever is still queued;
    // only an error tears both sides down at once.
    const fail = () => {
      client.destroy();
      remote.destroy();
    };
    client.on("error", fail).on("close", () => sockets.delete(client));
    remote.on("error", fail).on("close", () => sockets.delete(remote));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    dropAll() {
      for (const s of sockets) s.destroy();
    },
    outage() {
      down = true;
      for (const s of sockets) s.destroy();
    },
    restore() {
      down = false;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
