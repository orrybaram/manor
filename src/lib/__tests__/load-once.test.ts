import { describe, expect, it, vi } from "vitest";
import { loadOnce } from "../load-once";

describe("loadOnce", () => {
  it("shares one load between callers", async () => {
    const load = vi.fn(() => Promise.resolve("x"));
    const get = loadOnce(load);

    expect(get()).toBe(get());
    await expect(get()).resolves.toBe("x");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("retries a load that failed instead of caching the failure", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("chunk failed"))
      .mockResolvedValueOnce("x");
    const get = loadOnce(load);

    await expect(get()).rejects.toThrow("chunk failed");
    await expect(get()).resolves.toBe("x");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
