import { beforeEach, describe, it, expect, vi } from "vitest";
import { useSnoozeStore } from "../snooze-store";

const STORAGE_KEY = "manor.home.snoozes";

function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
  return data;
}

describe("snooze-store", () => {
  let storage: Map<string, string>;

  function state() {
    return useSnoozeStore.getState();
  }

  beforeEach(() => {
    storage = stubStorage();
    useSnoozeStore.setState({ until: {} });
  });

  describe("snooze", () => {
    it("sets until time for a key", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);

      state().snooze("item-1", 60000);

      expect(state().until["item-1"]).toBe(1000 + 60000);

      vi.useRealTimers();
    });

    it("defaults to 1 hour", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);

      state().snooze("item-1");

      expect(state().until["item-1"]).toBe(1000 + 60 * 60 * 1000);

      vi.useRealTimers();
    });

    it("updates an existing snooze", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);

      state().snooze("item-1", 10000);
      expect(state().until["item-1"]).toBe(11000);

      vi.setSystemTime(5000);
      state().snooze("item-1", 20000);
      expect(state().until["item-1"]).toBe(5000 + 20000);

      vi.useRealTimers();
    });

    it("persists to localStorage", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);

      state().snooze("item-1", 60000);

      const stored = JSON.parse(storage.get(STORAGE_KEY) || "{}");
      expect(stored["item-1"]).toBe(61000);

      vi.useRealTimers();
    });

    it("drops expired entries when persisting", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);

      state().snooze("item-1", 100000); // expires at 101000
      state().snooze("item-2", 10000); // expires at 11000

      // Move time forward past item-2's expiry
      vi.setSystemTime(50000);

      // Snooze a new item to trigger persistence
      state().snooze("item-3", 10000);

      const stored = JSON.parse(storage.get(STORAGE_KEY) || "{}");
      expect("item-1" in stored).toBe(true);
      expect("item-2" in stored).toBe(false);
      expect("item-3" in stored).toBe(true);

      vi.useRealTimers();
    });

    it("survives localStorage throwing on get", () => {
      vi.stubGlobal("localStorage", {
        getItem: () => {
          throw new Error("nope");
        },
        setItem: vi.fn(),
        removeItem: vi.fn(),
      });

      // Should not throw
      expect(() => {
        state().snooze("item-1", 10000);
      }).not.toThrow();

      storage = stubStorage();
    });

    it("survives localStorage throwing on set", () => {
      vi.stubGlobal("localStorage", {
        getItem: vi.fn(() => null),
        setItem: () => {
          throw new Error("nope");
        },
        removeItem: vi.fn(),
      });

      // Should not throw; falls back to in-memory
      expect(() => {
        state().snooze("item-1", 10000);
      }).not.toThrow();
      expect(state().until["item-1"]).toBeDefined();

      storage = stubStorage();
    });
  });

  describe("activeSnoozes", () => {
    it("returns empty set when no snoozes", () => {
      const active = state().activeSnoozes();
      expect(active.size).toBe(0);
    });

    it("returns keys with expiry > now", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);

      state().snooze("item-1", 10000); // expires at 11000
      state().snooze("item-2", 20000); // expires at 21000

      const active = state().activeSnoozes(5000); // check at 5000
      expect(active.has("item-1")).toBe(true);
      expect(active.has("item-2")).toBe(true);

      vi.useRealTimers();
    });

    it("excludes expired snoozes", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);

      state().snooze("item-1", 10000); // expires at 11000
      state().snooze("item-2", 20000); // expires at 21000

      const active = state().activeSnoozes(15000); // check at 15000
      expect(active.has("item-1")).toBe(false);
      expect(active.has("item-2")).toBe(true);

      vi.useRealTimers();
    });

    it("uses current time by default", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);

      state().snooze("item-1", 10000); // expires at 11000

      vi.setSystemTime(12000);
      const active = state().activeSnoozes(); // no explicit time
      expect(active.has("item-1")).toBe(false);

      vi.useRealTimers();
    });
  });

  describe("loading persisted state", () => {
    async function loadFresh() {
      vi.resetModules();
      return (await import("../snooze-store")).useSnoozeStore.getState();
    }

    it("loads persisted snoozes", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);

      stubStorage({
        [STORAGE_KEY]: JSON.stringify({
          "item-1": 10000,
          "item-2": 20000,
        }),
      });

      const store = await loadFresh();
      expect(store.until["item-1"]).toBe(10000);
      expect(store.until["item-2"]).toBe(20000);

      vi.useRealTimers();
    });

    it("drops expired entries on load", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(15000);

      stubStorage({
        [STORAGE_KEY]: JSON.stringify({
          "item-1": 10000, // expired
          "item-2": 20000, // not expired
        }),
      });

      const store = await loadFresh();
      expect("item-1" in store.until).toBe(false);
      expect(store.until["item-2"]).toBe(20000);

      vi.useRealTimers();
    });

    it("ignores corrupt JSON", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);

      stubStorage({
        [STORAGE_KEY]: "not json",
      });

      const store = await loadFresh();
      expect(store.until).toEqual({});

      vi.useRealTimers();
    });

    it("ignores invalid data format", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);

      stubStorage({
        [STORAGE_KEY]: JSON.stringify({
          "item-1": "not a number",
          "item-2": 20000,
        }),
      });

      const store = await loadFresh();
      expect("item-1" in store.until).toBe(false);
      expect(store.until["item-2"]).toBe(20000);

      vi.useRealTimers();
    });

    it("defaults to empty when storage key missing", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);

      stubStorage();

      const store = await loadFresh();
      expect(store.until).toEqual({});

      vi.useRealTimers();
    });
  });

});
