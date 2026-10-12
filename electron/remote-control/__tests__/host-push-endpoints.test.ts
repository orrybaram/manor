import { describe, it, expect, vi } from "vitest";
import { HostPushEndpoints } from "../host-push-endpoints";

describe("HostPushEndpoints", () => {
  it("is empty for a host it has not heard from", () => {
    const cache = new HostPushEndpoints({ status: vi.fn() });
    expect(cache.get("box").size).toBe(0);
  });

  it("caches a host's endpoints and replaces them on refresh", async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce({ pushEndpoints: ["https://a"] })
      .mockResolvedValueOnce({ pushEndpoints: ["https://b"] });
    const cache = new HostPushEndpoints({ status });
    await cache.refresh("box");
    expect([...cache.get("box")]).toEqual(["https://a"]);
    await cache.refresh("box");
    expect([...cache.get("box")]).toEqual(["https://b"]);
    expect(cache.get("other").size).toBe(0);
  });

  it("clears the cache when the host cannot be asked", async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce({ pushEndpoints: ["https://a"] })
      .mockRejectedValueOnce(new Error("gone"))
      .mockResolvedValueOnce(null);
    const cache = new HostPushEndpoints({ status });
    await cache.refresh("box");
    await cache.refresh("box");
    expect(cache.get("box").size).toBe(0);
    cache.set("box", ["https://c"]);
    await cache.refresh("box");
    expect(cache.get("box").size).toBe(0);
  });
});
