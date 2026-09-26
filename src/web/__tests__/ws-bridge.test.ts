/**
 * The bridge client, against a fake socket (ADR-178 ticket 4).
 *
 * The server half is tested over a real listener in
 * `electron/remote-control/__tests__/ws-bridge.test.ts`, because its
 * properties are transport-level. This half's properties are not: they are
 * "what did the proxy turn this call into", "who got this event", and "what
 * happened to the calls that were in flight". A fake `WebSocket` is the only
 * way to ask the last one at all — a real socket cannot be made to drop
 * mid-invoke on demand.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  BridgeDisconnectedError,
  BridgeUnavailableError,
  bridgeUrlFromLocation,
  createWsBridge,
  WEB_TOKEN_KEY,
  type WsBridgeOptions,
} from "../ws-bridge";
import type { ElectronAPI } from "../../electron";

type Frame = Record<string, unknown>;

/** A socket the test drives by hand. Records what the client sent it. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static get last(): FakeSocket {
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (!socket) throw new Error("no socket was opened");
    return socket;
  }

  readyState = 0;
  readonly frames: Frame[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Frame);
  }

  close(): void {
    this.readyState = 3;
  }

  /** The server accepted the upgrade. */
  accept(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** One frame from the server. */
  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  /** Accept and answer the hello — the state every test but one starts in. */
  handshake(): void {
    this.accept();
    this.deliver({ type: "hello", ok: true, v: 1 });
  }

  of(kind: string): Frame[] {
    return this.frames.filter((frame) => frame.kind === kind);
  }
}

/** The frame of its kind the client sent most recently. */
function last(frames: Frame[]): Frame {
  const frame = frames[frames.length - 1];
  if (!frame) throw new Error("no frame of that kind was sent");
  return frame;
}

describe("createWsBridge", () => {
  let reload: ReturnType<typeof vi.fn>;
  let store: Map<string, string>;

  function bridge(options: Partial<WsBridgeOptions> = {}): ElectronAPI {
    return createWsBridge({
      token: "full-token",
      url: "ws://manor.test/ws",
      ...options,
    });
  }

  /** A bridge with an open, authenticated socket behind it. */
  function connected(options: Partial<WsBridgeOptions> = {}): {
    api: ElectronAPI;
    socket: FakeSocket;
  } {
    const api = bridge(options);
    // Nothing dials until something asks; `getAll` is the first ask.
    void api.projects.getAll().catch(() => {});
    const socket = FakeSocket.last;
    socket.handshake();
    return { api, socket };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    store = new Map();
    reload = vi.fn();
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    });
    vi.stubGlobal("location", {
      protocol: "http:",
      host: "manor.test:7777",
      reload,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("connecting", () => {
    it("derives ws:// or wss:// from the page", () => {
      expect(bridgeUrlFromLocation()).toBe("ws://manor.test:7777/ws");
      vi.stubGlobal("location", { protocol: "https:", host: "x.ts.net" });
      expect(bridgeUrlFromLocation()).toBe("wss://x.ts.net/ws");
    });

    it("opens nothing until something calls", () => {
      bridge();
      expect(FakeSocket.instances).toHaveLength(0);
    });

    it("says hello with the token before anything else", () => {
      const api = bridge();
      void api.projects.getAll().catch(() => {});
      const socket = FakeSocket.last;
      socket.accept();
      expect(socket.frames).toEqual([{ type: "hello", token: "full-token" }]);
    });

    it("holds calls made before the hello is answered", () => {
      const api = bridge();
      void api.projects.getAll().catch(() => {});
      const socket = FakeSocket.last;
      socket.accept();
      expect(socket.of("invoke")).toHaveLength(0);
      socket.deliver({ type: "hello", ok: true, v: 1 });
      expect(socket.of("invoke")).toHaveLength(1);
    });

    it("never dials without a token", () => {
      const api = bridge({ token: null });
      void expect(api.projects.getAll()).rejects.toBeInstanceOf(
        BridgeDisconnectedError,
      );
      expect(FakeSocket.instances).toHaveLength(0);
    });
  });

  describe("invoke", () => {
    it("round-trips a call as one frame and one result", async () => {
      const { api, socket } = connected();
      const pending = api.projects.select(2);
      const frame = last(socket.of("invoke"));
      expect(frame).toMatchObject({
        kind: "invoke",
        ns: "projects",
        method: "select",
        args: [2],
      });
      socket.deliver({
        id: frame.id,
        kind: "result",
        ok: true,
        result: { ok: true },
      });
      await expect(pending).resolves.toEqual({ ok: true });
    });

    it("gives each call its own id", async () => {
      const { api, socket } = connected();
      void api.pty.write("pane-a", "ls\r");
      void api.pty.write("pane-b", "ls\r");
      const ids = socket.of("invoke").map((frame) => frame.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("raises BridgeUnavailableError for unavailable:web", async () => {
      const { api, socket } = connected();
      const pending = api.layout.save({} as never);
      const frame = last(socket.of("invoke"));
      socket.deliver({
        id: frame.id,
        kind: "result",
        ok: false,
        error: "Layout changes are not saved from the browser yet",
        code: "unavailable:web",
      });
      await expect(pending).rejects.toBeInstanceOf(BridgeUnavailableError);
      await expect(pending).rejects.toThrow("not saved from the browser");
    });

    it("raises a plain Error for a handler that threw", async () => {
      const { api, socket } = connected();
      const pending = api.pty.write("pane-a", "ls\r");
      const frame = last(socket.of("invoke"));
      socket.deliver({
        id: frame.id,
        kind: "result",
        ok: false,
        error: "expected a string",
        code: "failed",
      });
      await expect(pending).rejects.toThrow("expected a string");
      await expect(pending).rejects.not.toBeInstanceOf(BridgeUnavailableError);
    });

    it("ignores a frame it has no pending call for", () => {
      const { socket } = connected();
      expect(() =>
        socket.deliver({ id: "nobody", kind: "result", ok: true }),
      ).not.toThrow();
    });
  });

  describe("subscriptions", () => {
    it("subscribes with the paneId as the key", () => {
      const { api, socket } = connected();
      api.pty.onOutput("pane-a", () => {});
      expect(last(socket.of("subscribe"))).toEqual({
        kind: "subscribe",
        ns: "pty",
        event: "output",
        key: "pane-a",
      });
    });

    it("delivers a pane's output to that pane's listener only", () => {
      const { api, socket } = connected();
      const a = vi.fn();
      const b = vi.fn();
      api.pty.onOutput("pane-a", a);
      api.pty.onOutput("pane-b", b);

      socket.deliver({
        kind: "event",
        ns: "pty",
        event: "output",
        key: "pane-a",
        args: ["hello", 7],
      });

      expect(a).toHaveBeenCalledWith("hello", 7);
      expect(b).not.toHaveBeenCalled();
    });

    it("keeps the preload's argument shapes", () => {
      const { api, socket } = connected();
      const resized = vi.fn();
      api.pty.onResized("pane-a", resized);
      socket.deliver({
        kind: "event",
        ns: "pty",
        event: "resized",
        key: "pane-a",
        args: [120, 40],
      });
      expect(resized).toHaveBeenCalledWith(120, 40);
    });

    it("subscribes keylessly for a machine-wide event", () => {
      const { api, socket } = connected();
      const changed = vi.fn();
      api.preferences.onChange(changed);
      // `onChange` → `changed`: the preload named the verb, the host names
      // the fact. No key: this is not about one pane.
      expect(last(socket.of("subscribe"))).toEqual({
        kind: "subscribe",
        ns: "preferences",
        event: "changed",
      });
      socket.deliver({
        kind: "event",
        ns: "preferences",
        event: "changed",
        args: [{ statsEnabled: true }],
      });
      expect(changed).toHaveBeenCalledWith({ statsEnabled: true });
    });

    it("maps the root's onProjectsChanged onto projects.changed", () => {
      const { api, socket } = connected();
      const changed = vi.fn();
      api.onProjectsChanged(changed);
      expect(last(socket.of("subscribe"))).toEqual({
        kind: "subscribe",
        ns: "projects",
        event: "changed",
      });
      socket.deliver({
        kind: "event",
        ns: "projects",
        event: "changed",
        args: [],
      });
      expect(changed).toHaveBeenCalledOnce();
    });

    it("maps agents.onUpdate onto agents.updated", () => {
      const { api, socket } = connected();
      api.agents.onUpdate(() => {});
      expect(last(socket.of("subscribe"))).toMatchObject({
        ns: "agents",
        event: "updated",
      });
    });

    it("unsubscribes on the wire once the last listener goes", () => {
      const { api, socket } = connected();
      const first = api.pty.onExit("pane-a", () => {});
      const second = api.pty.onExit("pane-a", () => {});

      // One subscription for the pane, however many listeners it has.
      expect(socket.of("subscribe")).toHaveLength(1);
      first();
      expect(socket.of("unsubscribe")).toHaveLength(0);
      second();
      expect(last(socket.of("unsubscribe"))).toEqual({
        kind: "unsubscribe",
        ns: "pty",
        event: "exit",
        key: "pane-a",
      });
    });

    it("stops delivering after unsubscribe", () => {
      const { api, socket } = connected();
      const cb = vi.fn();
      const off = api.pty.onCwd("pane-a", cb);
      off();
      socket.deliver({
        kind: "event",
        ns: "pty",
        event: "cwd",
        key: "pane-a",
        args: ["/tmp"],
      });
      expect(cb).not.toHaveBeenCalled();
    });

    it("survives a listener that throws", () => {
      const { api, socket } = connected();
      const second = vi.fn();
      vi.spyOn(console, "error").mockImplementation(() => {});
      api.pty.onOutput("pane-a", () => {
        throw new Error("bad listener");
      });
      api.pty.onOutput("pane-a", second);
      socket.deliver({
        kind: "event",
        ns: "pty",
        event: "output",
        key: "pane-a",
        args: ["x"],
      });
      expect(second).toHaveBeenCalledWith("x");
    });
  });

  describe("reconnecting", () => {
    it("re-sends every live subscription on the new socket", () => {
      const { api, socket } = connected();
      const cb = vi.fn();
      api.pty.onOutput("pane-a", cb);
      api.preferences.onChange(() => {});

      socket.drop();
      vi.advanceTimersByTime(1_000);
      const reopened = FakeSocket.last;
      expect(reopened).not.toBe(socket);
      reopened.handshake();

      expect(reopened.of("subscribe")).toEqual([
        { kind: "subscribe", ns: "pty", event: "output", key: "pane-a" },
        { kind: "subscribe", ns: "preferences", event: "changed" },
      ]);

      reopened.deliver({
        kind: "event",
        ns: "pty",
        event: "output",
        key: "pane-a",
        args: ["back"],
      });
      expect(cb).toHaveBeenCalledWith("back");
    });

    it("backs off towards a ceiling while the host stays down", () => {
      connected();
      let opened = 1;
      // 1s doubling to a 30s cap: a laptop that closed its lid should not
      // leave a hundred failed dials in the tunnel's log.
      for (const delay of [
        1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
      ]) {
        FakeSocket.last.drop();
        vi.advanceTimersByTime(delay - 1);
        expect(FakeSocket.instances).toHaveLength(opened);
        vi.advanceTimersByTime(1);
        opened += 1;
        expect(FakeSocket.instances).toHaveLength(opened);
      }
    });

    it("starts the backoff over once a socket got through", () => {
      connected();
      FakeSocket.last.drop();
      vi.advanceTimersByTime(1_000);
      FakeSocket.last.drop();
      vi.advanceTimersByTime(2_000);
      FakeSocket.last.handshake();

      FakeSocket.last.drop();
      const opened = FakeSocket.instances.length;
      vi.advanceTimersByTime(1_000);
      expect(FakeSocket.instances).toHaveLength(opened + 1);
    });

    it("rejects the calls that were in flight", async () => {
      const { api, socket } = connected();
      const pending = api.projects.getAll();
      socket.drop();
      await expect(pending).rejects.toBeInstanceOf(BridgeDisconnectedError);
    });

    it("does not reconnect after a 4403", () => {
      const onForbidden = vi.fn();
      const { socket } = connected({ onForbidden });
      socket.drop(4403);
      vi.advanceTimersByTime(60_000);
      expect(onForbidden).toHaveBeenCalledOnce();
      expect(FakeSocket.instances).toHaveLength(1);
    });

    it("forgets the token and reloads on a 4401", () => {
      store.set(WEB_TOKEN_KEY, "full-token");
      const { socket } = connected();
      socket.drop(4401);
      expect(store.has(WEB_TOKEN_KEY)).toBe(false);
      expect(reload).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(60_000);
      expect(FakeSocket.instances).toHaveLength(1);
    });
  });

  describe("what the browser answers itself", () => {
    it("reports the platform the components branch on", () => {
      const api = bridge();
      expect(api.platform).toBe("web");
      expect(api.isDetached).toBe(false);
      expect(api.detachedWindowId).toBeNull();
      expect(api.env.isPackaged).toBe(false);
    });

    it("refuses a browser-impossible namespace without a frame", async () => {
      const { api, socket } = connected();
      const before = socket.frames.length;
      await expect(api.dialog.openDirectory()).rejects.toBeInstanceOf(
        BridgeUnavailableError,
      );
      await expect(api.webview.zoomIn("pane-a")).rejects.toBeInstanceOf(
        BridgeUnavailableError,
      );
      expect(socket.frames).toHaveLength(before);
    });

    it("hands a browser-impossible subscription a no-op unsubscribe", () => {
      const { api, socket } = connected();
      const before = socket.frames.length;
      const off = api.webview.onEscape(() => {});
      expect(off).toBeTypeOf("function");
      expect(() => off()).not.toThrow();
      expect(socket.frames).toHaveLength(before);
    });

    it("swallows the fire-and-forget calls with nothing to forget", () => {
      const { api, socket } = connected();
      const before = socket.frames.length;
      expect(api.menu.setContext({} as never)).toBeUndefined();
      expect(api.window.setPosition(10, 10)).toBeUndefined();
      expect(socket.frames).toHaveLength(before);
    });

    it("keeps a two-level namespace callable at both levels", () => {
      const { api, socket } = connected();
      // `git.push` is a method *and* a namespace in `preload.ts`; DiffPane
      // subscribes through the second level while the pane mounts.
      const off = api.git.push.onProgress(() => {});
      expect(off).toBeTypeOf("function");
      expect(last(socket.of("subscribe"))).toEqual({
        kind: "subscribe",
        ns: "git.push",
        event: "progress",
      });
      void api.git.push.start({ wsPath: "/tmp" }).catch(() => {});
      expect(last(socket.of("invoke"))).toMatchObject({
        ns: "git.push",
        method: "start",
        args: [{ wsPath: "/tmp" }],
      });
      expect(() => off()).not.toThrow();
    });

    it("is not a thenable", async () => {
      const api = bridge();
      await expect(Promise.resolve(api)).resolves.toBe(api);
    });
  });
});
