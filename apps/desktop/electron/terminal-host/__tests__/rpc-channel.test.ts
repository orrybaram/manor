import { describe, it, expect, vi } from "vitest";
import { Duplex } from "node:stream";
import { RpcChannel } from "../rpc-channel";

/** A socket whose writes are recorded and whose replies the test pushes. */
function fakeSocket() {
  const written: Array<Record<string, unknown>> = [];
  const socket = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, cb) {
      for (const line of chunk.toString("utf-8").split("\n")) {
        if (line.trim()) written.push(JSON.parse(line));
      }
      cb();
    },
  });
  const reply = (payload: Record<string, unknown>) =>
    socket.push(JSON.stringify(payload) + "\n");
  /** Answer the last request written with `payload`, under its requestId. */
  const answer = (payload: Record<string, unknown>) =>
    reply({ ...payload, requestId: written[written.length - 1].requestId });
  return { socket, written, reply, answer };
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

describe("RpcChannel", () => {
  it("resolves a call with its successful reply", async () => {
    const rpc = new RpcChannel(() => {});
    const { socket, answer } = fakeSocket();
    rpc.attach(socket);

    const pending = rpc.call({ type: "listSessions" });
    await flush();
    answer({ type: "sessions", sessions: [] });
    await expect(pending).resolves.toEqual({ type: "sessions", sessions: [] });
  });

  it("throws the daemon's message on an error reply", async () => {
    const rpc = new RpcChannel(() => {});
    const { socket, answer } = fakeSocket();
    rpc.attach(socket);

    const pending = rpc.call({ type: "ping" });
    await flush();
    answer({ type: "error", message: "Not authenticated" });
    await expect(pending).rejects.toThrow("Not authenticated");
  });

  it("throws on a reply of the wrong type", async () => {
    const rpc = new RpcChannel(() => {});
    const { socket, answer } = fakeSocket();
    rpc.attach(socket);

    const pending = rpc.call({ type: "ping" });
    await flush();
    answer({ type: "killed" });
    await expect(pending).rejects.toThrow("unexpected killed reply to ping");
  });

  it("hands `request` an error reply instead of throwing it", async () => {
    const rpc = new RpcChannel(() => {});
    const { socket, answer } = fakeSocket();
    rpc.attach(socket);

    const pending = rpc.request({ type: "handshake", clientVersion: "1" });
    await flush();
    answer({ type: "error", message: "nope" });
    await expect(pending).resolves.toEqual({ type: "error", message: "nope" });
  });

  it("sends ordinary calls one at a time, but concurrent ones straight away", async () => {
    const rpc = new RpcChannel(() => {});
    const { socket, written } = fakeSocket();
    rpc.attach(socket);

    void rpc.call({ type: "ping" }).catch(() => {});
    void rpc.call({ type: "listSessions" }).catch(() => {});
    void rpc.callConcurrent({ type: "readFile", path: "/f" }, null).catch(() => {});
    void rpc
      .callConcurrent({ type: "writeFile", path: "/f", base64: "" }, null)
      .catch(() => {});
    await flush();
    // listSessions waits behind ping's reply; readFile/writeFile do not wait
    // at all.
    expect(written.map((m) => m.type).sort()).toEqual([
      "ping",
      "readFile",
      "writeFile",
    ]);
    rpc.close();
  });

  it("times out, and tells its owner", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const rpc = new RpcChannel(onTimeout);
      rpc.attach(fakeSocket().socket);

      const pending = rpc.call({ type: "ping" }, 50);
      const assertion = expect(pending).rejects.toThrow("Request timed out: ping");
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(onTimeout).toHaveBeenCalledWith("ping");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails pending calls on close", async () => {
    const rpc = new RpcChannel(() => {});
    const { socket } = fakeSocket();
    rpc.attach(socket);

    const pending = rpc.call({ type: "ping" });
    await flush();
    rpc.close();
    await expect(pending).rejects.toThrow("Disconnected");
    expect(socket.destroyed).toBe(true);
  });

  it("ignores replies from a socket it no longer owns", async () => {
    const rpc = new RpcChannel(() => {});
    const old = fakeSocket();
    const current = fakeSocket();
    rpc.attach(old.socket);
    rpc.attach(current.socket);

    const pending = rpc.call({ type: "ping" });
    await flush();
    const requestId = current.written[0].requestId;
    old.reply({ type: "error", message: "stale", requestId });
    await flush();
    current.reply({ type: "pong", requestId });
    await expect(pending).resolves.toEqual({ type: "pong" });
  });
});
