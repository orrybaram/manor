/**
 * The proxy, over a transport that is not a socket (ADR-180 ticket 3).
 *
 * What is asserted here is the half of the client that is the same on a
 * desktop and in a browser: what `ns.method(...)` turns into, what a
 * listener (`ns.onX(cb)`) turns into, and the order the four places an answer can
 * come from are consulted in — a native namespace the transport serves in
 * process, a single method it serves itself, the browser-impossible set, and
 * finally the transport. The socket's own properties (hello, outbox,
 * reconnect, the close codes) are `ws.test.ts`'s.
 *
 * A fake transport rather than a fake socket, because the point of the split
 * is that this code no longer knows there is one.
 */

import { describe, it, expect, vi } from "vitest";

import {
  BridgeUnavailableError,
  createBridge,
  type BridgeListener,
  type BridgeTransport,
} from "../client";
import type { ElectronAPI } from "../../electron";

interface Call {
  ns: string;
  method: string;
  args: unknown[];
}

interface Subscription {
  ns: string;
  event: string;
  key: string | undefined;
  callback: BridgeListener;
}

/** A transport that records rather than connects. */
class FakeTransport implements BridgeTransport {
  readonly invokes: Call[] = [];
  readonly subscriptions: Subscription[] = [];
  readonly unsubscribed: Subscription[] = [];
  starts = 0;
  /** What the next invoke resolves with. */
  result: unknown = undefined;

  rendererId: string | null = "renderer-7";
  readonly platform: "electron" | "web";
  rootValues: Record<string, unknown>;
  localNamespaces: Record<string, unknown>;
  locallyServed: Record<string, (...args: unknown[]) => unknown>;

  constructor(
    options: {
      platform?: "electron" | "web";
      rootValues?: Record<string, unknown>;
      localNamespaces?: Record<string, unknown>;
      locallyServed?: Record<string, (...args: unknown[]) => unknown>;
    } = {},
  ) {
    this.platform = options.platform ?? "web";
    this.rootValues = options.rootValues ?? {};
    this.localNamespaces = options.localNamespaces ?? {};
    this.locallyServed = options.locallyServed ?? {};
  }

  start(): void {
    this.starts += 1;
  }

  invoke(ns: string, method: string, args: unknown[]): Promise<unknown> {
    this.invokes.push({ ns, method, args });
    return Promise.resolve(this.result);
  }

  subscribe(
    ns: string,
    event: string,
    key: string | undefined,
    callback: BridgeListener,
  ): () => void {
    const subscription = { ns, event, key, callback };
    this.subscriptions.push(subscription);
    return () => this.unsubscribed.push(subscription);
  }

  /** The last thing of its kind, or a failure that says which was missing. */
  get lastInvoke(): Call {
    const call = this.invokes[this.invokes.length - 1];
    if (!call) throw new Error("nothing was invoked");
    return call;
  }

  get lastSubscription(): Subscription {
    const subscription = this.subscriptions[this.subscriptions.length - 1];
    if (!subscription) throw new Error("nothing was subscribed to");
    return subscription;
  }
}

function bridgeOver(transport: FakeTransport): ElectronAPI {
  return createBridge(transport);
}

describe("createBridge", () => {
  describe("invoking", () => {
    it("turns a namespaced call into one invoke", async () => {
      const transport = new FakeTransport();
      transport.result = { ok: true };
      const api = bridgeOver(transport);

      await expect(api.projects.select(2)).resolves.toEqual({ ok: true });
      expect(transport.lastInvoke).toEqual({
        ns: "projects",
        method: "select",
        args: [2],
      });
    });

    it("keeps a two-level namespace callable at both levels", () => {
      const transport = new FakeTransport();
      const api = bridgeOver(transport);

      const off = api.git.push.onProgress(() => {});
      expect(off).toBeTypeOf("function");
      expect(transport.lastSubscription).toMatchObject({
        ns: "git.push",
        event: "progress",
      });

      void api.git.push.start({ wsPath: "/tmp" });
      expect(transport.lastInvoke).toEqual({
        ns: "git.push",
        method: "start",
        args: [{ wsPath: "/tmp" }],
      });
      expect(() => off()).not.toThrow();
    });

    it("wakes the transport before the first call and not only then", () => {
      const transport = new FakeTransport();
      const api = bridgeOver(transport);
      expect(transport.starts).toBe(0);
      void api.projects.getAll();
      api.pty.onExit("pane-a", () => {});
      expect(transport.starts).toBe(2);
    });

    it("is not a thenable", async () => {
      const api = bridgeOver(new FakeTransport());
      await expect(Promise.resolve(api)).resolves.toBe(api);
    });
  });

  describe("subscribing", () => {
    it("takes the paneId off the front as the key", () => {
      const transport = new FakeTransport();
      const cb = vi.fn();
      bridgeOver(transport).pty.onOutput("pane-a", cb);

      expect(transport.lastSubscription).toMatchObject({
        ns: "pty",
        event: "output",
        key: "pane-a",
      });
      transport.lastSubscription.callback("hello", 7);
      expect(cb).toHaveBeenCalledWith("hello", 7);
    });

    it("names no key for a machine-wide event", () => {
      const transport = new FakeTransport();
      bridgeOver(transport).preferences.onChange(() => {});
      expect(transport.lastSubscription).toMatchObject({
        ns: "preferences",
        event: "changed",
        key: undefined,
      });
    });

    it("maps projects.onChanged onto projects.changed", () => {
      const transport = new FakeTransport();
      bridgeOver(transport).projects.onChanged(() => {});
      expect(transport.lastSubscription).toMatchObject({
        ns: "projects",
        event: "changed",
        key: undefined,
      });
    });

    it("maps agents.onUpdate onto agents.updated", () => {
      const transport = new FakeTransport();
      bridgeOver(transport).agents.onUpdate(() => {});
      expect(transport.lastSubscription).toMatchObject({
        ns: "agents",
        event: "updated",
      });
    });

    it("hands back the transport's unsubscribe", () => {
      const transport = new FakeTransport();
      const off = bridgeOver(transport).pty.onExit("pane-a", () => {});
      off();
      expect(transport.unsubscribed).toHaveLength(1);
    });

    /**
     * `onOutput` is a subscription; `once` is a method that starts with "on".
     * The rule is the capital letter *and* a function as the last argument.
     */
    it("invokes an on-prefixed method that was handed no callback", () => {
      const transport = new FakeTransport();
      const agents = bridgeOver(transport).agents as unknown as {
        onUpdate: () => Promise<unknown>;
      };
      void agents.onUpdate();
      expect(transport.lastInvoke).toMatchObject({
        ns: "agents",
        method: "onUpdate",
      });
      expect(transport.subscriptions).toHaveLength(0);
    });
  });

  describe("what the transport answers itself", () => {
    it("calls a native namespace in process, with its own `this`", () => {
      const pty = {
        name: "pty",
        write(this: { name: string }, paneId: string, data: string): string {
          return `${this.name}:${paneId}:${data}`;
        },
      };
      const transport = new FakeTransport({ localNamespaces: { pty } });
      const api = bridgeOver(transport);

      expect(api.pty.write("pane-a", "ls\r") as unknown).toBe(
        "pty:pane-a:ls\r",
      );
      expect(transport.invokes).toHaveLength(0);
      expect(transport.starts).toBe(0);
    });

    it("walks a native two-level namespace", () => {
      const start = vi.fn(() => "started");
      const transport = new FakeTransport({
        localNamespaces: { git: { push: { start } } },
      });
      expect(bridgeOver(transport).git.push.start({ wsPath: "/tmp" })).toBe(
        "started",
      );
      expect(start).toHaveBeenCalledWith({ wsPath: "/tmp" });
      expect(transport.invokes).toHaveLength(0);
    });

    it("never resolves a member off the prototype chain", () => {
      const transport = new FakeTransport({ localNamespaces: { pty: {} } });
      const api = bridgeOver(transport) as unknown as {
        pty: { hasOwnProperty: (key: string) => unknown };
      };
      // The point of the test: `hasOwnProperty` is exactly the member a
      // prototype-chain lookup would find, and it must not be found.
      // eslint-disable-next-line no-prototype-builtins
      void api.pty.hasOwnProperty("write");
      expect(transport.lastInvoke).toMatchObject({
        ns: "pty",
        method: "hasOwnProperty",
      });
    });

    it("falls through to the transport for a method the namespace lacks", () => {
      const transport = new FakeTransport({
        localNamespaces: { pty: { write: vi.fn() } },
      });
      void bridgeOver(transport).pty.reset("pane-a", null, 80, 24);
      expect(transport.lastInvoke).toMatchObject({
        ns: "pty",
        method: "reset",
      });
    });

    it("serves one named method without a round trip", () => {
      const setContext = vi.fn(() => undefined);
      const transport = new FakeTransport({
        locallyServed: { "menu.setContext": setContext },
      });
      expect(
        bridgeOver(transport).menu.setContext({} as never),
      ).toBeUndefined();
      expect(setContext).toHaveBeenCalledOnce();
      expect(transport.invokes).toHaveLength(0);
    });
  });

  describe("what no browser can do", () => {
    it("refuses a browser-impossible namespace without asking", async () => {
      const transport = new FakeTransport();
      const api = bridgeOver(transport);
      await expect(api.dialog.openDirectory()).rejects.toBeInstanceOf(
        BridgeUnavailableError,
      );
      await expect(api.webview.zoomIn("pane-a")).rejects.toBeInstanceOf(
        BridgeUnavailableError,
      );
      expect(transport.invokes).toHaveLength(0);
    });

    it("hands a browser-impossible subscription a no-op unsubscribe", () => {
      const transport = new FakeTransport();
      const off = bridgeOver(transport).webview.onEscape(() => {});
      expect(off).toBeTypeOf("function");
      expect(() => off()).not.toThrow();
      expect(transport.subscriptions).toHaveLength(0);
    });

    /**
     * The same namespace on a desktop is native, and the refusal above never
     * happens: step 1 answers it. This is what makes one client serve both.
     */
    it("does not refuse it when the transport serves it in process", () => {
      const zoomIn = vi.fn(() => "zoomed");
      const transport = new FakeTransport({
        platform: "electron",
        localNamespaces: { webview: { zoomIn } },
      });
      expect(bridgeOver(transport).webview.zoomIn("pane-a") as unknown).toBe(
        "zoomed",
      );
      expect(zoomIn).toHaveBeenCalledWith("pane-a");
    });
  });

  describe("the facts a component reads while it renders", () => {
    it("answers platform synchronously, from the transport", () => {
      expect(bridgeOver(new FakeTransport()).platform).toBe("web");
      expect(
        bridgeOver(new FakeTransport({ platform: "electron" })).platform,
      ).toBe("electron");
    });

    it("answers the transport's root values and its connection id", () => {
      const transport = new FakeTransport({
        platform: "electron",
        rootValues: {
          claim: { workspacePath: "/w", tabId: "t1" },
          env: { isPackaged: true },
        },
      });
      const api = bridgeOver(transport);
      expect(api.claim).toEqual({ workspacePath: "/w", tabId: "t1" });
      expect(api.env.isPackaged).toBe(true);
      expect(api.rendererId).toBe("renderer-7");
    });

    it("reports the id the transport learns later", () => {
      const transport = new FakeTransport();
      transport.rendererId = null;
      const api = bridgeOver(transport);
      expect(api.rendererId).toBeNull();
      transport.rendererId = "bridge-3";
      expect(api.rendererId).toBe("bridge-3");
    });
  });
});
