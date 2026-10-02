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
  close(): Promise<void>;
}

export async function startLatencyProxy(
  upstream: string,
  rttMs: number,
): Promise<LatencyProxy> {
  const target = new URL(upstream);
  const oneWay = rttMs / 2;
  const sockets = new Set<net.Socket>();

  const pipeDelayed = (from: net.Socket, to: net.Socket) => {
    let releaseAt = 0;
    from.on("data", (chunk) => {
      releaseAt = Math.max(releaseAt, Date.now() + oneWay);
      setTimeout(() => {
        if (!to.destroyed) to.write(chunk);
      }, releaseAt - Date.now());
    });
    // After the last chunk is out, not half a trip after it arrived: a body
    // still queued would be cut short.
    from.on("end", () => {
      releaseAt = Math.max(releaseAt, Date.now() + oneWay);
      setTimeout(() => to.end(), releaseAt - Date.now() + 1);
    });
  };

  const server = net.createServer((client) => {
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
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
