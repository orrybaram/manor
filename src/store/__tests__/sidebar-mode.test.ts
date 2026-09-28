import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../project-store";

const KEY = "manor:sidebarMode";

function state() {
  return useProjectStore.getState();
}

function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
  return data;
}

let storage: Map<string, string>;

beforeEach(() => {
  storage = stubStorage();
  useProjectStore.setState({
    sidebarMode: "full",
    lastVisibleSidebarMode: "full",
  });
});

describe("sidebar mode actions", () => {
  it("setSidebarMode persists and tracks the last visible mode", () => {
    state().setSidebarMode("rail");
    expect(state().sidebarMode).toBe("rail");
    expect(state().lastVisibleSidebarMode).toBe("rail");
    expect(storage.get(KEY)).toBe("rail");

    state().setSidebarMode("hidden");
    expect(state().lastVisibleSidebarMode).toBe("rail");
    expect(storage.get(KEY)).toBe("hidden");
  });

  it("toggleSidebarRail goes full -> rail -> full and hidden -> full", () => {
    state().toggleSidebarRail();
    expect(state().sidebarMode).toBe("rail");
    state().toggleSidebarRail();
    expect(state().sidebarMode).toBe("full");
    state().setSidebarMode("hidden");
    state().toggleSidebarRail();
    expect(state().sidebarMode).toBe("full");
  });

  it("toggleSidebarHidden hides, then restores the last visible mode", () => {
    state().setSidebarMode("rail");
    state().toggleSidebarHidden();
    expect(state().sidebarMode).toBe("hidden");
    state().toggleSidebarHidden();
    expect(state().sidebarMode).toBe("rail");
  });

  it("survives localStorage throwing", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("nope");
      },
      setItem: () => {
        throw new Error("nope");
      },
    });
    state().setSidebarMode("rail");
    expect(state().sidebarMode).toBe("rail");
  });
});

describe("loading the persisted mode", () => {
  async function loadFresh() {
    vi.resetModules();
    return (await import("../project-store")).useProjectStore.getState();
  }

  it("defaults to full", async () => {
    const s = await loadFresh();
    expect(s.sidebarMode).toBe("full");
  });

  it("loads rail", async () => {
    stubStorage({ [KEY]: "rail" });
    const s = await loadFresh();
    expect(s.sidebarMode).toBe("rail");
    expect(s.lastVisibleSidebarMode).toBe("rail");
  });

  it("loads hidden with full as the last visible mode", async () => {
    stubStorage({ [KEY]: "hidden" });
    const s = await loadFresh();
    expect(s.sidebarMode).toBe("hidden");
    expect(s.lastVisibleSidebarMode).toBe("full");
  });

  it("rejects unknown values", async () => {
    stubStorage({ [KEY]: "sideways" });
    const s = await loadFresh();
    expect(s.sidebarMode).toBe("full");
  });
});
