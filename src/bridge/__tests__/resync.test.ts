/** The resync signal (ADR-220 D1): a plain listener set. */

import { describe, it, expect, vi, afterEach } from "vitest";

import { emitBridgeResync, onBridgeResync } from "../resync";

describe("the bridge resync signal", () => {
  const offs: (() => void)[] = [];

  afterEach(() => {
    for (const off of offs.splice(0)) off();
    vi.restoreAllMocks();
  });

  it("runs every listener on each emit", () => {
    const a = vi.fn();
    const b = vi.fn();
    offs.push(onBridgeResync(a), onBridgeResync(b));
    emitBridgeResync();
    emitBridgeResync();
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("stops calling a listener once it unsubscribes", () => {
    const cb = vi.fn();
    const off = onBridgeResync(cb);
    off();
    emitBridgeResync();
    expect(cb).not.toHaveBeenCalled();
  });

  it("isolates a listener that throws", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const after = vi.fn();
    offs.push(
      onBridgeResync(() => {
        throw new Error("bad store");
      }),
      onBridgeResync(after),
    );
    expect(() => emitBridgeResync()).not.toThrow();
    expect(after).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });

  it("does not skip a listener when another unsubscribes mid-emit", () => {
    const second = vi.fn();
    const off = onBridgeResync(() => off());
    offs.push(onBridgeResync(second));
    emitBridgeResync();
    expect(second).toHaveBeenCalledOnce();
  });
});
