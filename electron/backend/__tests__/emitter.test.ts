import { describe, it, expect, vi } from "vitest";
import { Emitter } from "../emitter";

describe("Emitter", () => {
  it("calls every listener until it unsubscribes", () => {
    const emitter = new Emitter<[string, number]>("[test] listener");
    const a = vi.fn();
    const b = vi.fn();
    const offA = emitter.on(a);
    emitter.on(b);
    emitter.emit("x", 1);
    offA();
    emitter.emit("y", 2);
    expect(a.mock.calls).toEqual([["x", 1]]);
    expect(b.mock.calls).toEqual([["x", 1], ["y", 2]]);
    expect(emitter.size).toBe(1);
  });

  it("keeps going past a listener that throws", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const emitter = new Emitter<[number]>("[test] listener");
    const after = vi.fn();
    emitter.on(() => {
      throw new Error("boom");
    });
    emitter.on(after);
    emitter.emit(1);
    expect(after).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith("[test] listener threw:", expect.any(Error));
    error.mockRestore();
  });
});
