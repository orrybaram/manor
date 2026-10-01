/**
 * The one listener registry both client transports keep (ADR-182 D5).
 *
 * The preload's tests (`electron/bridge/__tests__/ipc-transport.test.ts`) and
 * the socket's (`./ws.test.ts`) exercise it through their transports; this
 * file pins the two properties that are easiest to lose in a rewrite: the
 * count survives a shared callback, and `keys()` replays a namespace with a
 * dot in it as that namespace.
 */

import { describe, it, expect, vi } from "vitest";

import { SubscriptionRegistry } from "../subscription-registry";

describe("SubscriptionRegistry", () => {
  it("counts one callback subscribed twice as two subscriptions", () => {
    const tell = vi.fn();
    const registry = new SubscriptionRegistry(tell);
    const callback = vi.fn();

    const first = registry.subscribe("pty", "output", "pane-a", callback);
    const second = registry.subscribe("pty", "output", "pane-a", callback);
    first();

    registry.deliver({ ns: "pty", event: "output", key: "pane-a", args: [1] });
    expect(callback).toHaveBeenCalledOnce();
    expect(tell).toHaveBeenCalledTimes(1);

    second();
    expect(tell).toHaveBeenLastCalledWith({
      kind: "unsubscribe",
      ns: "pty",
      event: "output",
      key: "pane-a",
    });
  });

  it("replays every live key, with a dotted namespace kept whole", () => {
    const registry = new SubscriptionRegistry(() => {});
    registry.subscribe("git.push", "progress", null, () => {});
    registry.subscribe("pty", "output", "pane-a", () => {});
    const released = registry.subscribe("pty", "exit", "pane-a", () => {});
    released();

    expect(registry.keys()).toEqual([
      { kind: "subscribe", ns: "git.push", event: "progress" },
      { kind: "subscribe", ns: "pty", event: "output", key: "pane-a" },
    ]);
  });

  it("keeps delivering to the others when one listener throws", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const registry = new SubscriptionRegistry(() => {});
    const after = vi.fn();
    registry.subscribe("stats", "changed", null, () => {
      throw new Error("boom");
    });
    registry.subscribe("stats", "changed", null, after);

    registry.deliver({ ns: "stats", event: "changed", args: [] });

    expect(after).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
