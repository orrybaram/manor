/**
 * Every push is a frame (ADR-180 D5).
 *
 * Main tells every renderer — window or browser — about the world through
 * the host surface. The three properties that has to hold, and that nothing
 * else checks, are here:
 *
 * - a **broadcast** reaches every connection that asked for it;
 * - an **addressed** push reaches exactly one, which is the thing broadcast
 *   cannot express and the reason `sendTo` exists (`app-command` to the
 *   primary window, `menu.command` to the focused one, a worktree's setup
 *   progress to whoever asked for the worktree);
 * - a subscription for pane A never hears pane B, because subscription
 *   membership is the *whole* event filter — one connection carries every
 *   pane a renderer has open.
 *
 * The failure mode this guards against is silence. A converted send-site that
 * nobody wired up, or a frame named `worktree:setup-progress` on one side and
 * `worktreeProgress` on the other, is a feature that quietly stops updating;
 * it is not a type error and no screen goes red.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { HostDeps } from "../../ipc/types";
import {
  publishRendererBroadcast,
  publishToRenderer,
  connectionIdForWindow,
  setRendererWindowResolver,
} from "../../renderer-broadcast";
import { BridgeServer } from "../server";
import { FrameSerialiser } from "../transports/ws";
import type { BridgeConnection, EventFrame } from "../types";

/** A connection that remembers what it was sent. Neither socket nor window. */
function makeConnection(id: string, callerClass: "local" | "device" = "local") {
  const frames: EventFrame[] = [];
  const connection: BridgeConnection = {
    id,
    callerClass,
    deviceId: null,
    deviceLabel: null,
    send: (frame) => {
      if (frame.kind === "event") frames.push(frame);
    },
  };
  return { connection, frames };
}

describe("bridge events", () => {
  let server: BridgeServer;

  beforeEach(() => {
    const deps = {
      getRendererWindows: () => [],
    } as unknown as HostDeps;
    server = new BridgeServer(deps, { handlers: {} });
  });

  afterEach(() => {
    server.dispose();
  });

  it("delivers a broadcast to every connection that subscribed", () => {
    const a = makeConnection("a");
    const b = makeConnection("b");
    const quiet = makeConnection("quiet");
    for (const c of [a, b, quiet]) server.accept(c.connection);
    server.subscribe(a.connection, "ports", "changed");
    server.subscribe(b.connection, "ports", "changed");

    publishRendererBroadcast("ports", "changed", [{ port: 3000 }] as never);

    const expected = {
      kind: "event",
      ns: "ports",
      event: "changed",
      args: [[{ port: 3000 }]],
    };
    expect(a.frames).toEqual([expected]);
    expect(b.frames).toEqual([expected]);
    // Subscription membership is the whole filter: never asked, never told.
    expect(quiet.frames).toEqual([]);
  });

  it("delivers an addressed push to exactly one connection", () => {
    const primary = makeConnection("1");
    const other = makeConnection("2");
    for (const c of [primary, other]) server.accept(c.connection);
    // Both are listening for the same thing. Only one asked for the worktree.
    server.subscribe(primary.connection, "appCommands", "command");
    server.subscribe(other.connection, "appCommands", "command");

    publishToRenderer("1", "appCommands", "command", {
      cmd: "focus-pane",
      requestId: "req-1",
    });

    expect(primary.frames).toEqual([
      {
        kind: "event",
        ns: "appCommands",
        event: "command",
        args: [{ cmd: "focus-pane", requestId: "req-1" }],
      },
    ]);
    expect(other.frames).toEqual([]);
  });

  it("drops an addressed push for a connection that is gone", () => {
    const only = makeConnection("1");
    server.accept(only.connection);
    server.subscribe(only.connection, "menu", "command");

    expect(() =>
      publishToRenderer("nobody", "menu", "command", { commandId: "new-tab" }),
    ).not.toThrow();
    expect(only.frames).toEqual([]);
  });

  it("never sends pane B's output to a subscriber of pane A", () => {
    const watcher = makeConnection("a");
    server.accept(watcher.connection);
    server.subscribe(watcher.connection, "pty", "output", "pane-A");

    server.handleStreamEvent({
      type: "data",
      sessionId: "pane-B",
      data: "not yours",
      seq: 1,
    } as never);
    expect(watcher.frames).toEqual([]);

    server.handleStreamEvent({
      type: "data",
      sessionId: "pane-A",
      data: "yours",
      seq: 2,
    } as never);
    expect(watcher.frames).toEqual([
      {
        kind: "event",
        ns: "pty",
        event: "output",
        args: ["yours", 2],
        key: "pane-A",
      },
    ]);
  });

  it("gives a keyless subscriber every pane", () => {
    const watcher = makeConnection("a");
    server.accept(watcher.connection);
    server.subscribe(watcher.connection, "pty", "exit");

    server.handleStreamEvent({ type: "exit", sessionId: "pane-B" } as never);

    expect(watcher.frames).toEqual([
      { kind: "event", ns: "pty", event: "exit", args: [], key: "pane-B" },
    ]);
  });

  it("stops delivering after an unsubscribe, and after a drop", () => {
    const a = makeConnection("a");
    const b = makeConnection("b");
    for (const c of [a, b]) server.accept(c.connection);
    server.subscribe(a.connection, "diffs", "changed");
    server.subscribe(b.connection, "diffs", "changed");

    server.unsubscribe(a.connection, "diffs", "changed");
    server.drop("b");
    publishRendererBroadcast("diffs", "changed", {});

    expect(a.frames).toEqual([]);
    expect(b.frames).toEqual([]);
  });
});

describe("connectionIdForWindow", () => {
  afterEach(() => {
    setRendererWindowResolver(null);
  });

  it("is null with no transport listening", () => {
    expect(connectionIdForWindow({ webContents: { id: 4 } })).toBeNull();
  });

  it("asks the transport, and tolerates a null window", () => {
    setRendererWindowResolver((win) => (win.webContents.id === 4 ? "4" : null));
    expect(connectionIdForWindow({ webContents: { id: 4 } })).toBe("4");
    expect(connectionIdForWindow({ webContents: { id: 9 } })).toBeNull();
    expect(connectionIdForWindow(null)).toBeNull();
  });

  it("is null rather than a throw when the transport blows up", () => {
    setRendererWindowResolver(() => {
      throw new Error("no");
    });
    expect(connectionIdForWindow({ webContents: { id: 4 } })).toBeNull();
  });
});

describe("FrameSerialiser", () => {
  it("stringifies one frame once, however many sockets want it", () => {
    const spy = vi.spyOn(JSON, "stringify");
    try {
      const json = new FrameSerialiser();
      const frame = { kind: "event", ns: "pty", event: "output", args: ["x"] };

      const first = json.of(frame);
      const second = json.of(frame);
      const third = json.of(frame);

      expect(first).toBe(second);
      expect(second).toBe(third);
      expect(spy).toHaveBeenCalledTimes(1);

      // A genuinely new frame is a genuinely new stringify.
      json.of({ ...frame, args: ["y"] });
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});
