import { describe, expect, it, vi } from "vitest";
import { cjsExports, lazy } from "./lazy";

describe("lazy", () => {
  it("loads once and shares the load", async () => {
    const load = vi.fn(async () => 42);
    const get = lazy(load);
    expect(get.started()).toBeNull();
    const [a, b] = await Promise.all([get(), get()]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(await get()).toBe(42);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("started() never starts a load", async () => {
    const load = vi.fn(async () => "x");
    const get = lazy(load);
    expect(get.started()).toBeNull();
    expect(load).not.toHaveBeenCalled();
    void get();
    expect(await get.started()).toBe("x");
  });

  it("forgets a failed load so the next call retries", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("missing chunk"))
      .mockResolvedValueOnce("ok");
    const get = lazy(load);
    await expect(get()).rejects.toThrow("missing chunk");
    expect(get.started()).toBeNull();
    expect(await get()).toBe("ok");
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("cjsExports", () => {
  it("returns the namespace when the export sits on it", () => {
    const ns = { run: () => 1 };
    expect(cjsExports(ns, "run")).toBe(ns);
  });

  it("returns `default` when the bundler wrapped the exports", () => {
    const inner = { run: () => 1 };
    const ns = { default: inner } as unknown as typeof inner;
    expect(cjsExports(ns, "run")).toBe(inner);
  });
});
