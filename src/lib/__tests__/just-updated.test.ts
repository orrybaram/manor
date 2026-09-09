import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const KEY = "manor:lastSeenVersion";

/** The suite runs in Node, which has no Web Storage of its own. */
function fakeStorage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    clear: () => entries.clear(),
  };
}

/** Fresh module each time — the answer is memoised per renderer. */
async function load() {
  vi.resetModules();
  return await import("../just-updated");
}

describe("hasJustUpdated", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeStorage());
    vi.stubGlobal("__APP_VERSION__", "0.3.0");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stays quiet on a first launch and records the version", async () => {
    const { hasJustUpdated } = await load();
    expect(hasJustUpdated()).toBe(false);
    expect(localStorage.getItem(KEY)).toBe("0.3.0");
  });

  it("reports an update when the stored version differs", async () => {
    localStorage.setItem(KEY, "0.2.1");
    const { hasJustUpdated } = await load();
    expect(hasJustUpdated()).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("0.3.0");
  });

  it("stays quiet on a relaunch of the same version", async () => {
    localStorage.setItem(KEY, "0.3.0");
    const { hasJustUpdated } = await load();
    expect(hasJustUpdated()).toBe(false);
  });

  it("keeps its answer once the version is stamped", async () => {
    localStorage.setItem(KEY, "0.2.1");
    const { hasJustUpdated } = await load();
    expect(hasJustUpdated()).toBe(true);
    expect(hasJustUpdated()).toBe(true);
  });
});
