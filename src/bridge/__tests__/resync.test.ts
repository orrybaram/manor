/** The resync signal: a plain listener set. */

import { describe, it, expect, vi, afterEach } from "vitest";

import {
  bootAndResync,
  emitBridgeResync,
  liveValue,
  onBridgeResync,
} from "../resync";

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

  it("resolves the emit once every listener's promise has settled", async () => {
    let finish: () => void = () => {};
    offs.push(
      onBridgeResync(() => new Promise<void>((r) => (finish = r))),
      onBridgeResync(() => Promise.reject(new Error("offline"))),
    );
    let done = false;
    const emitted = emitBridgeResync().then(() => (done = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    finish();
    await emitted;
    expect(done).toBe(true);
  });

  describe("bootAndResync", () => {
    it("loads now, again on every resync, and not after unsubscribing", () => {
      const load = vi.fn();
      const off = bootAndResync(load);
      expect(load).toHaveBeenCalledTimes(1);
      emitBridgeResync();
      expect(load).toHaveBeenCalledTimes(2);
      off();
      emitBridgeResync();
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("swallows a rejected load", async () => {
      const load = vi.fn().mockRejectedValue(new Error("offline"));
      offs.push(bootAndResync(load));
      emitBridgeResync();
      await Promise.resolve();
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("hands the emit its load's promise", async () => {
      let finish: () => void = () => {};
      offs.push(bootAndResync(() => new Promise<void>((r) => (finish = r))));
      let done = false;
      const emitted = emitBridgeResync().then(() => (done = true));
      await Promise.resolve();
      expect(done).toBe(false);
      finish();
      await emitted;
    });
  });

  describe("liveValue", () => {
    /** A push source the test drives, and a fetch it answers by hand. */
    function source() {
      let push: (value: number) => void = () => {};
      const answers: ((value: number) => void)[] = [];
      return {
        fetch: vi.fn(
          () => new Promise<number>((resolve) => answers.push(resolve)),
        ),
        onPush: (cb: (value: number) => void) => {
          push = cb;
          return () => (push = () => {});
        },
        push: (value: number) => push(value),
        answer: (value: number) => answers.shift()!(value),
      };
    }

    it("applies the boot fetch, pushes, and a resync's fetch", async () => {
      const src = source();
      const apply = vi.fn();
      offs.push(liveValue(src.fetch, src.onPush, apply));
      src.answer(1);
      await Promise.resolve();
      src.push(2);
      const resynced = emitBridgeResync();
      src.answer(3);
      await resynced;
      expect(apply.mock.calls.map(([v]) => v)).toEqual([1, 2, 3]);
    });

    it("drops a fetch that a push overtook", async () => {
      const src = source();
      const apply = vi.fn();
      offs.push(liveValue(src.fetch, src.onPush, apply));
      src.push(2);
      src.answer(1);
      await Promise.resolve();
      expect(apply.mock.calls.map(([v]) => v)).toEqual([2]);
    });

    it("applies nothing after it stops", async () => {
      const src = source();
      const apply = vi.fn();
      const stop = liveValue(src.fetch, src.onPush, apply);
      stop();
      src.answer(1);
      src.push(2);
      await emitBridgeResync();
      expect(apply).not.toHaveBeenCalled();
      expect(src.fetch).toHaveBeenCalledOnce();
    });
  });
});
