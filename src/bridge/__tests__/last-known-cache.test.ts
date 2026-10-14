/**
 * The router's last-known answers (`../last-known-cache.ts`, ADR-228 D6):
 * in memory, and read back in from a saved store once per server.
 */

import { describe, expect, it, vi } from "vitest";

import { callKey, createLastKnownCache } from "../last-known-cache";
import type { LastKnownStore } from "../last-known";

function store(saved: Record<string, Record<string, unknown>>) {
  return {
    read: vi.fn(async (id: string): Promise<ReadonlyMap<string, unknown>> =>
      new Map(Object.entries(saved[id] ?? {})),
    ),
    write: vi.fn<LastKnownStore["write"]>(),
    forget: vi.fn<LastKnownStore["forget"]>(),
  } satisfies LastKnownStore;
}

describe("the last-known cache", () => {
  it("recalls what it was told, and saves it", async () => {
    const persisted = store({});
    const cache = createLastKnownCache(persisted, () => true);
    const memo = callKey("projects.getAll", []);
    expect(await cache.recall("box", memo)).toBeNull();
    cache.remember("box", memo, ["p1"]);
    expect(await cache.recall("box", memo)).toEqual({ value: ["p1"] });
    expect(persisted.write).toHaveBeenCalledWith("box", memo, ["p1"]);
  });

  it("reads saved answers in once, under the ones heard since", async () => {
    const persisted = store({ box: { a: "saved-a", b: "saved-b" } });
    const cache = createLastKnownCache(persisted, () => true);
    cache.remember("box", "a", "heard-a");
    expect(await cache.recall("box", "a")).toEqual({ value: "heard-a" });
    expect(await cache.recall("box", "b")).toEqual({ value: "saved-b" });
    expect(persisted.read).toHaveBeenCalledOnce();
  });

  it("drops saved answers for a server that left while they were read", async () => {
    const persisted = store({ box: { a: "saved-a" } });
    const cache = createLastKnownCache(persisted, () => false);
    expect(await cache.recall("box", "a")).toBeNull();
  });

  it("forgets a server for good, saved answers included", async () => {
    const persisted = store({});
    const cache = createLastKnownCache(persisted, () => true);
    cache.remember("box", "a", 1);
    cache.forget("box");
    expect(persisted.forget).toHaveBeenCalledWith("box");
    expect(await cache.recall("box", "a")).toBeNull();
  });

  it("keeps answers in memory alone with no store", async () => {
    const cache = createLastKnownCache(null, () => true);
    cache.remember("box", "a", 1);
    expect(await cache.recall("box", "a")).toEqual({ value: 1 });
  });
});
