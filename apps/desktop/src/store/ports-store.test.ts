import { describe, expect, it, vi } from "vitest";
import { acquirePortsScanner } from "./ports-store";

describe("acquirePortsScanner", () => {
  it("starts one scanner for many holders and stops after the last release", () => {
    const stop = vi.fn();
    const start = vi.fn(() => stop);

    const releaseA = acquirePortsScanner(start);
    const releaseB = acquirePortsScanner(start);
    expect(start).toHaveBeenCalledTimes(1);

    releaseA();
    releaseA();
    expect(stop).not.toHaveBeenCalled();

    releaseB();
    expect(stop).toHaveBeenCalledTimes(1);

    const releaseC = acquirePortsScanner(start);
    expect(start).toHaveBeenCalledTimes(2);
    releaseC();
    expect(stop).toHaveBeenCalledTimes(2);
  });
});
