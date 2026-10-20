import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../project-store";

const PORTS_KEY = "manor:portsCollapsed";
const AGENTS_KEY = "manor:agentsCollapsed";

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
  useProjectStore.setState({ portsCollapsed: false, agentsCollapsed: false });
});

describe("sidebar pane collapse", () => {
  it("persists the Ports pane's state", () => {
    state().setPortsCollapsed(true);
    expect(state().portsCollapsed).toBe(true);
    expect(storage.get(PORTS_KEY)).toBe("true");
    state().setPortsCollapsed(false);
    expect(storage.get(PORTS_KEY)).toBe("false");
  });

  it("persists the Agents pane's state independently", () => {
    state().setAgentsCollapsed(true);
    expect(state().agentsCollapsed).toBe(true);
    expect(state().portsCollapsed).toBe(false);
    expect(storage.get(AGENTS_KEY)).toBe("true");
    expect(storage.has(PORTS_KEY)).toBe(false);
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
    state().setAgentsCollapsed(true);
    expect(state().agentsCollapsed).toBe(true);
  });
});

describe("loading the persisted pane state", () => {
  async function loadFresh() {
    vi.resetModules();
    return (await import("../project-store")).useProjectStore.getState();
  }

  it("defaults to expanded", async () => {
    const s = await loadFresh();
    expect(s.portsCollapsed).toBe(false);
    expect(s.agentsCollapsed).toBe(false);
  });

  it("loads collapsed panes", async () => {
    stubStorage({ [PORTS_KEY]: "true", [AGENTS_KEY]: "true" });
    const s = await loadFresh();
    expect(s.portsCollapsed).toBe(true);
    expect(s.agentsCollapsed).toBe(true);
  });
});
