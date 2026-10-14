/**
 * The phone's saved last-known answers (ADR-228 D6): batched writes per
 * server, read back across a "reload", and nothing thrown when storage is
 * missing or refuses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLastKnownStore,
  indexedDbBackend,
  type LastKnownBackend,
} from "../last-known";

function memoryBackend(): LastKnownBackend & { data: Map<string, Record<string, unknown>> } {
  const data = new Map<string, Record<string, unknown>>();
  return {
    data,
    get: async (id) => (data.has(id) ? { ...data.get(id) } : undefined),
    put: async (id, saved) => void data.set(id, { ...saved }),
    delete: async (id) => void data.delete(id),
  };
}

describe("last-known store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("batches a server's answers and reads them back after a reload", async () => {
    const backend = memoryBackend();
    const store = createLastKnownStore(backend, 100);
    store.write("room-a", "projects.getAll:[]", [{ id: "p" }]);
    store.write("room-a", "layout.getAll:[]", { "/a": 1 });
    // Readable at once, before it lands.
    expect(await store.read("room-a")).toEqual(
      new Map<string, unknown>([
        ["projects.getAll:[]", [{ id: "p" }]],
        ["layout.getAll:[]", { "/a": 1 }],
      ]),
    );
    expect(backend.data.size).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(backend.data.get("room-a")).toEqual({
      "projects.getAll:[]": [{ id: "p" }],
      "layout.getAll:[]": { "/a": 1 },
    });

    const reloaded = createLastKnownStore(backend, 100);
    expect((await reloaded.read("room-a")).get("projects.getAll:[]")).toEqual([{ id: "p" }]);
    expect((await reloaded.read("room-b")).size).toBe(0);
  });

  it("keeps earlier answers when a later batch lands", async () => {
    const backend = memoryBackend();
    backend.data.set("room-a", { old: 1 });
    const store = createLastKnownStore(backend, 10);
    store.write("room-a", "new", 2);
    await vi.advanceTimersByTimeAsync(10);
    expect(backend.data.get("room-a")).toEqual({ old: 1, new: 2 });
  });

  it("forgets a server, pending writes included", async () => {
    const backend = memoryBackend();
    backend.data.set("room-a", { old: 1 });
    const store = createLastKnownStore(backend, 10);
    store.write("room-a", "new", 2);
    store.forget("room-a");
    await vi.advanceTimersByTimeAsync(10);
    expect(backend.data.has("room-a")).toBe(false);
    expect((await store.read("room-a")).size).toBe(0);
  });

  it("throws nothing when storage refuses, and keeps answers for the session", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const refusing: LastKnownBackend = {
      get: () => Promise.reject(new Error("denied")),
      put: () => {
        throw new Error("quota");
      },
      delete: () => Promise.reject(new Error("denied")),
    };
    const store = createLastKnownStore(refusing, 10);
    store.write("room-a", "m", 1);
    await vi.advanceTimersByTimeAsync(10);
    expect((await store.read("room-a")).get("m")).toBe(1);
    store.forget("room-a");
    await vi.advanceTimersByTimeAsync(10);
  });

  it("works without IndexedDB at all", async () => {
    expect(indexedDbBackend(undefined)).toBeNull();
    const store = createLastKnownStore(null);
    store.write("room-a", "m", 1);
    expect((await store.read("room-a")).size).toBe(0);
    store.forget("room-a");
  });

  it("gives up quietly on an IndexedDB that fails to open", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const factory = {
      open: () => {
        const request = {} as IDBOpenDBRequest;
        queueMicrotask(() => request.onerror?.(new Event("error")));
        return request;
      },
    } as unknown as IDBFactory;
    const store = createLastKnownStore(indexedDbBackend(factory), 10);
    expect((await store.read("room-a")).size).toBe(0);
    store.write("room-a", "m", 1);
    await vi.advanceTimersByTimeAsync(10);
  });
});
