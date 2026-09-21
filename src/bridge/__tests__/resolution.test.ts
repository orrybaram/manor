/**
 * Where an answer comes from, and in what order (ADR-180 D3/D7).
 *
 * `window.electronAPI` is a `Proxy`. Nothing about `pty.write` exists until
 * somebody reads that property, and what happens next is decided by four
 * consultations in a fixed order: the transport's native namespaces, the one
 * method it serves itself, the namespaces no browser can do, and finally a
 * frame. `client.test.ts` tests each of those steps against a fake; this file
 * tests the *order* — with the real `LOCALLY_SERVED` and the real
 * `UNAVAILABLE_NAMESPACES`, and with one method deliberately in two places at
 * once, because precedence is invisible until two of them could answer.
 *
 * It is the runtime half of the compile-time contract. `ElectronAPI` is
 * derived from the handler table, the preload and `SUBSCRIPTIONS`
 * (`electron/bridge/contract.ts`), and `electron/bridge/surface.ts` checks
 * what derivation cannot; this asserts that the client consults those sets
 * the way the derivation assumes — including, for every entry of
 * `SUBSCRIPTIONS`, that the event name the table declares is the one that
 * actually goes on the wire. That pairing is the one thing a type cannot hold
 * up, since the client derives an event's name by a rule (`onChange` →
 * `changed`) with a table of exceptions beside it.
 */

import { describe, it, expect, vi } from "vitest";

import { SUBSCRIPTIONS } from "../../../electron/bridge/events";
import {
  BridgeUnavailableError,
  createBridge,
  type BridgeListener,
  type BridgeTransport,
} from "../client";
import { LOCALLY_SERVED, UNAVAILABLE_NAMESPACES } from "../unavailable";
import type { ElectronAPI } from "../../electron";

interface Subscription {
  ns: string;
  event: string;
  key: string | undefined;
}

/** A transport that records rather than connects. */
class FakeTransport implements BridgeTransport {
  readonly invokes: { ns: string; method: string; args: unknown[] }[] = [];
  readonly subscriptions: Subscription[] = [];
  readonly rendererId = null;
  readonly platform = "web" as const;
  readonly rootValues = {};

  constructor(
    readonly localNamespaces: Record<string, unknown> = {},
    readonly locallyServed: Record<
      string,
      (...args: unknown[]) => unknown
    > = {},
  ) {}

  start(): void {}

  invoke(ns: string, method: string, args: unknown[]): Promise<unknown> {
    this.invokes.push({ ns, method, args });
    return Promise.resolve(null);
  }

  subscribe(
    ns: string,
    event: string,
    key: string | undefined,
    _callback: BridgeListener,
  ): () => void {
    this.subscriptions.push({ ns, event, key });
    return () => {};
  }
}

/** `api.git.push.onProgress` from `"git.push.onProgress"`. */
function member(api: ElectronAPI, methodPath: string): (...a: never[]) => void {
  const walked = methodPath
    .split(".")
    .reduce<unknown>(
      (owner, segment) => (owner as Record<string, unknown>)[segment],
      api,
    );
  return walked as (...a: never[]) => void;
}

describe("the order an answer is looked for in", () => {
  it("asks the transport's native namespaces first, before anything else", () => {
    const setContext = vi.fn();
    const served = vi.fn();
    // `menu` is in all three: a native namespace, a locally served method,
    // and the browser-impossible set. Native wins, which is why the desktop
    // never reaches the browser's no-op for a menu it really has.
    const transport = new FakeTransport(
      { menu: { setContext } },
      { "menu.setContext": served },
    );

    createBridge(transport).menu.setContext({ paneKind: "terminal" } as never);

    expect(setContext).toHaveBeenCalledTimes(1);
    expect(served).not.toHaveBeenCalled();
    expect(transport.invokes).toEqual([]);
  });

  it("then the one method the transport serves itself, refusal or no", () => {
    // The browser's case, with the real list: `menu` is a namespace it
    // refuses whole, and `menu.setContext` is still answered in the tab —
    // a label for a menu bar that is not on screen is a no-op, not an error
    // on every focus change.
    expect(UNAVAILABLE_NAMESPACES.has("menu")).toBe(true);
    expect(Object.keys(LOCALLY_SERVED)).toContain("menu.setContext");

    const transport = new FakeTransport({}, LOCALLY_SERVED);

    expect(
      createBridge(transport).menu.setContext({ paneKind: "terminal" } as never),
    ).toBeUndefined();
    expect(transport.invokes).toEqual([]);
  });

  it("then refuses a namespace no browser can do, without a round trip", async () => {
    const transport = new FakeTransport({}, LOCALLY_SERVED);
    const api = createBridge(transport);

    await expect(api.webview.register("pane-1", 7)).rejects.toBeInstanceOf(
      BridgeUnavailableError,
    );
    // A subscription on one gets a no-op unsubscribe instead: a component
    // that mounts and unmounts must not have to know it is in a browser.
    expect(api.webview.onEscape(() => {})).toBeInstanceOf(Function);
    expect(transport.invokes).toEqual([]);
    expect(transport.subscriptions).toEqual([]);
  });

  it("and only then sends a frame", async () => {
    const transport = new FakeTransport({}, LOCALLY_SERVED);

    await createBridge(transport).pty.write("pane-1", "ls\n");

    expect(transport.invokes).toEqual([
      { ns: "pty", method: "write", args: ["pane-1", "ls\n"] },
    ]);
  });

  it("keeps a method out of the tab's hands when the tab does not claim it", async () => {
    // `viewport.load` is served locally and `viewport.save` is too; nothing
    // else in the namespace is, and the next method added there must go to
    // the host rather than quietly resolve to a no-op.
    const transport = new FakeTransport({}, LOCALLY_SERVED);

    await createBridge(transport).layout.getAll();

    expect(transport.invokes).toEqual([
      { ns: "layout", method: "getAll", args: [] },
    ]);
  });
});

/**
 * Every listener on the contract, resolved. `SUBSCRIPTIONS` in
 * `electron/bridge/events.ts` declares these listeners and the wire name each
 * one listens on; this is what makes that declaration true of the client
 * rather than merely written down beside it.
 */
describe("SUBSCRIPTIONS resolve to the events they claim", () => {
  it.each(Object.entries(SUBSCRIPTIONS))(
    "%s subscribes to %s",
    (method, wire) => {
      const transport = new FakeTransport();
      const listen = member(createBridge(transport), method);
      // A `pty.*` subscription names the pane it is about; every other event
      // is about the machine and carries no key.
      const perPane = method.startsWith("pty.");
      listen(...((perPane ? ["pane-1", () => {}] : [() => {}]) as never[]));

      expect(transport.subscriptions).toEqual([
        {
          ns: wire.slice(0, wire.lastIndexOf(".")),
          event: wire.slice(wire.lastIndexOf(".") + 1),
          key: perPane ? "pane-1" : undefined,
        },
      ]);
    },
  );
});
