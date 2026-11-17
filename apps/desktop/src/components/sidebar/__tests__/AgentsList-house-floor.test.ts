// @vitest-environment jsdom
/**
 * The house floor ends only the full desk sidebar's Agents list: the rail's
 * popover (`fitContent`) and the phone layout never show it, even with dots
 * on the floor. The list's own stores and the floor's canvas are stubbed;
 * what's under test is AgentsList's rule.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  return { layout: "desk" as "desk" | "phone", dots: 40 };
});

vi.mock("../../../store/project-store", () => {
  const state = {
    agentsHeight: 200,
    setAgentsHeight: () => {},
    agentsCollapsed: false,
    setAgentsCollapsed: () => {},
  };
  const useProjectStore = (select: (s: typeof state) => unknown) => select(state);
  useProjectStore.getState = () => state;
  return { useProjectStore, MIN_AGENTS_HEIGHT: 60, MAX_AGENTS_HEIGHT: 500 };
});
vi.mock("../../../store/agent-store", () => ({ useAgentStore: { getState: () => ({}) } }));
vi.mock("../../../store/app-store", () => ({ useAppStore: { getState: () => ({}) } }));
vi.mock("../../../hooks/useVisibleAgents", () => ({ useVisibleAgents: () => [] }));
vi.mock("../../../hooks/useAgentPulse", () => ({ useAgentPulse: () => () => false }));
vi.mock("../../../utils/agent-navigation", () => ({ navigateToAgent: () => {} }));
vi.mock("../../../hooks/useLayoutMode", () => ({ useLayoutMode: () => env.layout }));
vi.mock("../../../store/house-floor-store", () => ({
  useHouseFloor: () => ({
    dots: env.dots,
    floorSize: 195,
    cols: 15,
    rows: 13,
    awake: false,
    settling: false,
    meals: 0,
    seed: 1,
    eat: () => {},
  }),
}));
vi.mock("../HouseFloor/HouseFloor", async () => {
  const { createElement: h } = await import("react");
  return { HouseFloor: () => h("div", { "data-testid": "house-floor" }) };
});

const { AgentsList } = await import("../AgentsList");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  env.layout = "desk";
  env.dots = 40;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: { fitContent?: boolean }) {
  act(() => root.render(createElement(AgentsList, props)));
}

const floor = () => container.querySelector('[data-testid="house-floor"]');

describe("AgentsList and the house floor", () => {
  it("ends the desk sidebar's list, and keeps it up with no live agents", () => {
    render({});
    expect(floor()).not.toBeNull();
  });

  it("isn't in the rail's popover, even with dots", () => {
    render({ fitContent: true });
    expect(floor()).toBeNull();
    // No live agents, so the popover's list has nothing to show at all.
    expect(container.innerHTML).toBe("");
  });

  it("isn't on the phone, even with dots", () => {
    env.layout = "phone";
    render({});
    expect(floor()).toBeNull();
    expect(container.innerHTML).toBe("");
  });
});
