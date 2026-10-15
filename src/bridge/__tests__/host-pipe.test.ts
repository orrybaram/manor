/**
 * A desktop window's host pipe (ADR-228 D4), and the socket transport over
 * it, against a fake `hostPipe` — what the preload exposes and main answers
 * (`electron/ipc/host-pipe.ts`). The other half, a real server behind a real
 * `server-bridge --viewer`, is `electron/host-server/__tests__/viewer-pipe.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createHostPipeTransport,
  hostPipe,
  type HostPipeApi,
} from "../transports/host-pipe";
import type { HelloReply } from "../transports/ws";

type Frame = Record<string, unknown>;

/** `hostPipe`, driven by hand. Main's side of each pipe is a record here. */
function fakeHostPipe(opts: { refuse?: boolean } = {}) {
  const frameListeners = new Set<(pipeId: string, text: string) => void>();
  const closedListeners = new Set<(pipeId: string, code: number) => void>();
  const opened: Array<{ hostId: string; pipeId: string }> = [];
  const sent: Array<{ pipeId: string; frame: Frame }> = [];
  const closedByWindow: string[] = [];
  let next = 1;
  let pendingOpens: Array<() => void> = [];
  let holdOpens = false;

  const api: HostPipeApi = {
    open: vi.fn((hostId: string) => {
      if (opts.refuse) return Promise.reject(new Error("no such handler"));
      const pipeId = `p${next++}`;
      opened.push({ hostId, pipeId });
      if (!holdOpens) return Promise.resolve(pipeId);
      return new Promise<string>((resolve) => {
        pendingOpens.push(() => resolve(pipeId));
      });
    }),
    send: vi.fn((pipeId: string, text: string) => {
      sent.push({ pipeId, frame: JSON.parse(text) as Frame });
    }),
    close: vi.fn((pipeId: string) => {
      closedByWindow.push(pipeId);
    }),
    onFrame: (callback) => {
      frameListeners.add(callback);
      return () => frameListeners.delete(callback);
    },
    onClosed: (callback) => {
      closedListeners.add(callback);
      return () => closedListeners.delete(callback);
    },
  };

  return {
    api,
    opened,
    sent,
    closedByWindow,
    /** The newest pipe's id. */
    get last(): string {
      const pipe = opened[opened.length - 1];
      if (!pipe) throw new Error("no pipe was opened");
      return pipe.pipeId;
    },
    /** One line from main for `pipeId`. */
    frame(pipeId: string, frame: unknown): void {
      for (const listener of [...frameListeners]) listener(pipeId, JSON.stringify(frame));
    },
    closed(pipeId: string, code: number): void {
      for (const listener of [...closedListeners]) listener(pipeId, code);
    },
    holdOpens(): void {
      holdOpens = true;
    },
    releaseOpens(): void {
      for (const resolve of pendingOpens.splice(0)) resolve();
      pendingOpens = [];
    },
    listeners: () => frameListeners.size + closedListeners.size,
  };
}

const HELLO = {
  type: "hello",
  ok: true,
  v: 1,
  rendererId: "c-7",
  appVersion: "1.2.3",
  hostName: "wsl-box",
  hostServer: true,
};

describe("the host pipe transport (ADR-228 D4)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Let the `open` promise settle without running the backoff timers. */
  const settle = async () => {
    for (let i = 0; i < 3; i++) await Promise.resolve();
  };

  it("says no hello, takes the stream's first hello reply as the handshake, then calls", async () => {
    const fake = fakeHostPipe();
    const hellos: HelloReply[] = [];
    const statuses: string[] = [];
    const transport = createHostPipeTransport(fake.api, "box", {
      onHello: (reply) => hellos.push(reply),
      onStatus: (status) => statuses.push(status),
    });

    const call = transport.invoke("projects", "getAll", []);
    await settle();
    expect(fake.opened).toEqual([{ hostId: "box", pipeId: "p1" }]);
    // `server-bridge` said the hello on the box; nothing went out yet.
    expect(fake.sent).toEqual([]);

    fake.frame("p1", HELLO);
    expect(hellos).toEqual([
      {
        rendererId: "c-7",
        appVersion: "1.2.3",
        hostName: "wsl-box",
        hostServer: true,
        resumed: false,
      },
    ]);
    expect(statuses).toEqual(["connected"]);
    expect(transport.rendererId).toBe("c-7");

    // The queued call goes out after the handshake, on this pipe.
    expect(fake.sent).toEqual([
      {
        pipeId: "p1",
        frame: { id: "1", kind: "invoke", ns: "projects", method: "getAll", args: [] },
      },
    ]);
    fake.frame("p1", { id: "1", kind: "result", ok: true, result: [{ id: "a" }] });
    await expect(call).resolves.toEqual([{ id: "a" }]);
  });

  it("delivers events for its own pipe and ignores another pipe's frames", async () => {
    const fake = fakeHostPipe();
    const transport = createHostPipeTransport(fake.api, "box");
    const heard: unknown[][] = [];
    transport.subscribe("projects", "changed", undefined, (...args) => heard.push(args));
    await settle();
    fake.frame(fake.last, HELLO);
    expect(fake.sent.map((s) => s.frame)).toEqual([
      { kind: "subscribe", ns: "projects", event: "changed" },
    ]);

    fake.frame("someone-else", { kind: "event", ns: "projects", event: "changed", args: [1] });
    fake.frame(fake.last, { kind: "event", ns: "projects", event: "changed", args: [2] });
    expect(heard).toEqual([[2]]);
  });

  it("treats main's close as unreachable, redials with backoff, and replays subscriptions", async () => {
    const fake = fakeHostPipe();
    const hellos: HelloReply[] = [];
    const statuses: string[] = [];
    const transport = createHostPipeTransport(fake.api, "box", {
      onHello: (reply) => hellos.push(reply),
      onStatus: (status) => statuses.push(status),
    });
    transport.subscribe("agents", "update", undefined, () => {});
    await settle();
    fake.frame("p1", HELLO);

    const inFlight = transport.invoke("projects", "getAll", []);
    fake.closed("p1", 4504);
    await expect(inFlight).rejects.toMatchObject({ name: "BridgeDisconnectedError" });
    expect(statuses).toEqual(["connected", "unreachable"]);
    // The listeners went with the pipe.
    expect(fake.listeners()).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.opened.map((p) => p.pipeId)).toEqual(["p1", "p2"]);
    fake.frame("p2", { ...HELLO, rendererId: "c-8" });
    expect(hellos[1]).toMatchObject({ rendererId: "c-8", resumed: true });
    expect(fake.sent.filter((s) => s.pipeId === "p2").map((s) => s.frame)).toEqual([
      { kind: "subscribe", ns: "agents", event: "update" },
    ]);
  });

  it("is unreachable when main will not open a pipe at all", async () => {
    const fake = fakeHostPipe({ refuse: true });
    const statuses: string[] = [];
    const transport = createHostPipeTransport(fake.api, "box", {
      onStatus: (status) => statuses.push(status),
    });
    transport.start();
    await settle();
    expect(statuses).toEqual(["unreachable"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.api.open).toHaveBeenCalledTimes(2);
  });

  it("answers a foreground probe from the pipe's own state", async () => {
    const fake = fakeHostPipe();
    fake.holdOpens();
    const transport = createHostPipeTransport(fake.api, "box");
    transport.start();
    await settle();
    // A foreground probe while still dialling redials nothing.
    await expect(transport.probeNow()).resolves.toBe("redialing");
    expect(fake.opened).toHaveLength(1);

    // Probing an open pipe asks nothing of main.
    fake.releaseOpens();
    await settle();
    fake.frame("p1", HELLO);
    await expect(transport.probeNow()).resolves.toBe("alive");
  });

  it("tells main when the window closes a pipe before main answered", async () => {
    const fake = fakeHostPipe();
    fake.holdOpens();
    const closes: number[] = [];
    const connection = hostPipe(fake.api, "box").connect({
      onOpen: () => {
        throw new Error("never opened");
      },
      onMessage: () => {},
      onClose: (code) => closes.push(code),
    });
    connection.close();
    expect(closes).toEqual([4504]);
    expect(connection.open).toBe(false);
    fake.releaseOpens();
    await settle();
    expect(fake.closedByWindow).toEqual(["p1"]);
    expect(() => connection.send("{}")).toThrow(/not open/);
  });
});
