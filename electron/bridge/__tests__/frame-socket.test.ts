/**
 * `WsBridgeServer.attach` over an in-memory `FrameSocket` (ADR-206 D5): the
 * hello gate must behave the same for any carrier of text frames.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { HostDeps } from "../../ipc/types";
import { BridgeServer } from "../server";
import type { BridgeHandler } from "../handlers";
import type { FrameSocket } from "../transports/frame-socket";
import { WsBridgeServer, type BridgeAuthenticator } from "../transports/ws";

class FakeSocket implements FrameSocket {
  open = true;
  terminated = false;
  helloTimeoutMs?: number;
  sent: Array<Record<string, unknown>> = [];
  closed: { code: number; reason: string } | null = null;
  private message: (text: string) => void = () => {};
  private closeCb: () => void = () => {};

  send(text: string): void {
    if (this.open) this.sent.push(JSON.parse(text));
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.open = false;
  }
  onMessage(cb: (text: string) => void): void {
    this.message = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  receive(frame: unknown): void {
    this.message(JSON.stringify(frame));
  }
  terminate(): void {
    this.terminated = true;
    this.open = false;
  }
  /** A peer that ignores the close: its frames still arrive. */
  sendAnyway(frame: unknown): void {
    this.message(JSON.stringify(frame));
  }
  hangUp(): void {
    this.open = false;
    this.closeCb();
  }
}

const deps = { getRendererWindows: () => [] } as unknown as HostDeps;

const authenticate: BridgeAuthenticator = (token) => {
  if (token === "good") {
    return { ok: true, device: { id: "dev-1", label: "Phone" } as never };
  }
  if (token === "read-only") return { ok: false, code: 4403 };
  return { ok: false, code: 4401 };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("WsBridgeServer.attach with a FrameSocket", () => {
  let server: BridgeServer;
  let ws: WsBridgeServer;
  let echoed: number;

  beforeEach(() => {
    echoed = 0;
    server = new BridgeServer(deps, {
      handlers: {
        "test.echo": (() => {
          echoed++;
          return "pong";
        }) as BridgeHandler,
      },
    });
    ws = new WsBridgeServer(server);
  });

  afterEach(() => {
    vi.useRealTimers();
    ws.dispose();
    server.dispose();
  });

  it("closes 4401 when no hello arrives in time", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    ws.attach(socket, authenticate);
    expect(ws.size).toBe(1);
    vi.advanceTimersByTime(5_001);
    expect(socket.closed?.code).toBe(4401);
    expect(ws.size).toBe(0);
  });

  it("waits the socket's own hello window when it has one", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    socket.helloTimeoutMs = 20_000;
    ws.attach(socket, authenticate);
    vi.advanceTimersByTime(5_001);
    expect(socket.closed).toBeNull();
    vi.advanceTimersByTime(15_000);
    expect(socket.closed?.code).toBe(4401);
  });

  it("closeDevice ends the session now, even for a peer that ignores the close", async () => {
    const socket = new FakeSocket();
    ws.attach(socket, authenticate);
    socket.receive({ type: "hello", token: "good" });
    await flush();
    expect(server.size).toBe(1);

    ws.closeDevice("dev-1");
    expect(socket.closed?.code).toBe(4401);
    expect(socket.terminated).toBe(true);
    expect(ws.size).toBe(0);
    expect(server.size).toBe(0);

    // Whatever it still sends is nobody's.
    socket.sendAnyway({
      id: "9",
      kind: "invoke",
      ns: "test",
      method: "echo",
      args: [],
    });
    await flush();
    expect(echoed).toBe(0);
  });

  it("closes 4401 on a bad token", () => {
    const socket = new FakeSocket();
    ws.attach(socket, authenticate);
    socket.receive({ type: "hello", token: "bad" });
    return flush().then(() => {
      expect(socket.closed?.code).toBe(4401);
      expect(ws.size).toBe(0);
    });
  });

  it("closes 4403 for a device below full", async () => {
    const socket = new FakeSocket();
    ws.attach(socket, authenticate);
    socket.receive({ type: "hello", token: "read-only" });
    await flush();
    expect(socket.closed?.code).toBe(4403);
  });

  it("answers hello and then an invoke", async () => {
    const socket = new FakeSocket();
    ws.attach(socket, authenticate);
    socket.receive({ type: "hello", token: "good", previousId: "r-1" });
    await flush();
    expect(socket.sent[0]).toMatchObject({
      type: "hello",
      ok: true,
      rendererId: "r-1",
    });

    socket.receive({
      id: "1",
      kind: "invoke",
      ns: "test",
      method: "echo",
      args: [],
    });
    await flush();
    expect(socket.sent[1]).toMatchObject({
      id: "1",
      kind: "result",
      ok: true,
      result: "pong",
    });

    socket.hangUp();
    expect(ws.size).toBe(0);
  });

  it("omits appVersion from the hello reply when none was given", async () => {
    const socket = new FakeSocket();
    ws.attach(socket, authenticate);
    socket.receive({ type: "hello", token: "good" });
    await flush();
    expect(socket.sent[0]).not.toHaveProperty("appVersion");
  });

  it("sends appVersion in the hello reply (ADR-206 D4)", async () => {
    const versioned = new WsBridgeServer(server, { appVersion: "1.2.3" });
    const socket = new FakeSocket();
    versioned.attach(socket, authenticate);
    socket.receive({ type: "hello", token: "good" });
    await flush();
    expect(socket.sent[0]).toMatchObject({
      type: "hello",
      ok: true,
      appVersion: "1.2.3",
    });
    versioned.dispose();
  });

  it("closeAll closes attached sockets", async () => {
    const socket = new FakeSocket();
    ws.attach(socket, authenticate);
    ws.closeAll();
    expect(socket.closed?.code).toBe(1001);
    expect(ws.size).toBe(0);
  });
});

describe("BridgeServer.receive", () => {
  it("runs nothing for a connection it has not accepted or has dropped", async () => {
    let ran = 0;
    const server = new BridgeServer(deps, {
      handlers: {
        "test.echo": (() => {
          ran++;
          return "pong";
        }) as BridgeHandler,
      },
    });
    const connection = {
      id: "c-1",
      callerClass: "device" as const,
      deviceId: "dev-1",
      deviceLabel: "Phone",
      send: () => {},
    };
    const invoke = {
      id: "1",
      kind: "invoke",
      ns: "test",
      method: "echo",
      args: [],
    };

    expect(await server.receive(connection, invoke)).toBeNull();
    server.accept(connection);
    expect(await server.receive(connection, invoke)).toMatchObject({
      ok: true,
    });
    server.drop(connection.id);
    expect(await server.receive(connection, invoke)).toBeNull();
    // A different connection object reusing the id is not this one.
    server.accept({ ...connection });
    expect(await server.receive(connection, invoke)).toBeNull();
    expect(ran).toBe(1);
    server.dispose();
  });
});
