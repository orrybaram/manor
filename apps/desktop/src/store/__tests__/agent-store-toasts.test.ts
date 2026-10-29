// @vitest-environment happy-dom
/**
 * "Agent needs input" / "Agent responded": derived from main's unseen flags,
 * raised on a transition in the focused window, kept off screen while the
 * agent's pane is on screen anywhere, and taken down once main stops
 * flagging the agent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "../agent-store";
import { useAppStore, type WorkspaceLayout } from "../app-store";
import { wireToastSubjects } from "../toast-subjects";
import { toastStore } from "../../toast/toast-store";
import { workspaceKey } from "../../lib/workspace-key";
import { makeAgent } from "../../test-utils/fixtures";
import type { AgentInfo } from "../../electron.d";

// This window's focus, as main reports it, driven by each test.
const focus = vi.hoisted(() => ({ focused: true }));
vi.mock("../../lib/window-focus", () => ({
  isWindowFocused: () => focus.focused,
  onWindowFocusChange: () => () => {},
}));

const navigateToAgent = vi.hoisted(() => vi.fn());
vi.mock("../../utils/agent-navigation", () => ({ navigateToAgent }));

const WS = workspaceKey("local", "/ws");

/**
 * One panel; the first tab is selected and shows `on-screen`, the second
 * `off-screen`, the third `popped` — claimed by a detached window.
 */
function layout(): WorkspaceLayout {
  return {
    panelTree: { type: "leaf", panelId: "p1" },
    panels: {
      p1: {
        id: "p1",
        pinnedTabIds: [],
        tabs: ["on-screen", "off-screen", "popped"].map((paneId, i) => ({
          id: `t${i}`,
          title: "Terminal",
          rootNode: { type: "leaf", paneId },
        })),
      },
    },
  };
}

const NONE = { responded: false, requires_input: false };
const RESPONDED = { responded: true, requires_input: false };
const NEEDS_INPUT = { responded: false, requires_input: true };

/** The toasts up, minus any playing their exit. */
const shown = () =>
  toastStore
    .getState()
    .toasts.filter((t) => !t.leaving)
    .map((t) => t.message);

const receive = (agent: AgentInfo, unseen: typeof NONE) =>
  useAgentStore.getState().receiveAgentUpdate(agent, unseen);

/** An agent working in `paneId`, already in the list with no flags. */
function working(id: string, paneId: string): AgentInfo {
  const agent = makeAgent({ id, paneId, name: `Agent ${id}`, lastAgentStatus: "working" });
  receive(agent, NONE);
  return agent;
}

function select(tabId: string): void {
  useAppStore.setState({
    viewports: {
      [WS]: { activePanelId: "p1", selectedTabIds: { p1: tabId }, focusedPaneIds: {} },
    },
  });
}

let unwire: () => void = () => {};

describe("agent attention toasts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    focus.focused = true;
    toastStore.setState({ toasts: [] });
    useAgentStore.setState({
      agents: [],
      unseenInputAgentIds: new Set(),
      unseenRespondedAgentIds: new Set(),
    });
    useAppStore.setState({
      workspaceLayouts: { [WS]: layout() },
      viewports: {},
      claims: { [WS]: [{ windowId: "win-2", tabId: "t2" }] },
      activeWorkspacePath: "/ws",
      activeWorkspaceHostId: "local",
    });
    unwire = wireToastSubjects();
  });

  afterEach(() => {
    unwire();
    vi.useRealTimers();
  });

  it("does not toast 'Agent responded' for an agent whose pane is on screen", () => {
    const agent = working("a1", "on-screen");
    receive({ ...agent, lastAgentStatus: "responded" }, RESPONDED);
    expect(shown()).toEqual([]);
  });

  it("does not toast for an agent whose pane a detached window shows", () => {
    const agent = working("a1", "popped");
    receive({ ...agent, lastAgentStatus: "requires_input" }, NEEDS_INPUT);
    expect(shown()).toEqual([]);
  });

  it("does not toast a responded that main inferred (no unseen flag)", () => {
    const agent = working("a3", "off-screen");
    receive({ ...agent, lastAgentStatus: "responded" }, NONE);
    expect(shown()).toEqual([]);
  });

  it("toasts 'Agent responded' off screen, for 10s", () => {
    const agent = working("a2", "off-screen");
    receive({ ...agent, lastAgentStatus: "responded" }, RESPONDED);
    expect(toastStore.getState().toasts).toMatchObject([
      {
        id: "agent-responded-a2",
        message: "Agent responded",
        detail: "Agent a2",
        status: "success",
        duration: 10_000,
        about: { agent: "a2" },
        action: { label: "Go to agent" },
      },
    ]);
    vi.advanceTimersByTime(10_000 + 200);
    expect(toastStore.getState().toasts).toEqual([]);
  });

  it("toasts 'Agent needs input' off screen until it is resolved", () => {
    const agent = working("a1", "off-screen");
    receive({ ...agent, lastAgentStatus: "requires_input" }, NEEDS_INPUT);
    expect(toastStore.getState().toasts).toMatchObject([
      { id: "agent-input-a1", message: "Agent needs input", duration: "sticky" },
    ]);
    vi.advanceTimersByTime(60_000);
    expect(shown()).toEqual(["Agent needs input"]);
  });

  it("'Go to agent' navigates to the agent and takes the toast down", () => {
    const agent = working("a1", "off-screen");
    receive({ ...agent, lastAgentStatus: "requires_input" }, NEEDS_INPUT);
    toastStore.getState().toasts[0].action!.onClick();
    expect(navigateToAgent).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
    expect(shown()).toEqual([]);
  });

  it("removes 'needs input' when the user navigates to the agent's pane", () => {
    const agent = working("a1", "off-screen");
    receive({ ...agent, lastAgentStatus: "requires_input" }, NEEDS_INPUT);
    expect(shown()).toEqual(["Agent needs input"]);
    select("t1");
    expect(shown()).toEqual([]);
  });

  it("removes 'needs input' when a detached window claims the agent's tab", () => {
    const agent = working("a1", "off-screen");
    receive({ ...agent, lastAgentStatus: "requires_input" }, NEEDS_INPUT);
    useAppStore.setState({ claims: { [WS]: [{ windowId: "win-2", tabId: "t1" }] } });
    expect(shown()).toEqual([]);
  });

  it("removes 'needs input' when the agent leaves requires_input, flag or no flag", () => {
    const agent = working("a1", "off-screen");
    receive({ ...agent, lastAgentStatus: "requires_input" }, NEEDS_INPUT);
    // Main leaves the input flag standing on the way back to work.
    receive({ ...agent, lastAgentStatus: "working" }, NEEDS_INPUT);
    expect(shown()).toEqual([]);
  });

  it("removes 'needs input' when it is marked seen elsewhere (phone, another window)", () => {
    const agent = working("a1", "off-screen");
    const waiting = { ...agent, lastAgentStatus: "requires_input" } as AgentInfo;
    receive(waiting, NEEDS_INPUT);
    // Main's broadcast after somebody else looked: same status, no flags.
    receive(waiting, NONE);
    expect(shown()).toEqual([]);
  });

  it("removes 'responded' early when it is seen", () => {
    const agent = working("a1", "off-screen");
    receive({ ...agent, lastAgentStatus: "responded" }, RESPONDED);
    useAgentStore.getState().markAgentSeen("a1");
    expect(shown()).toEqual([]);
  });

  it("never toasts a transition that happened while the window was unfocused", () => {
    const agent = working("a1", "off-screen");
    focus.focused = false;
    receive({ ...agent, lastAgentStatus: "requires_input" }, NEEDS_INPUT);
    expect(shown()).toEqual([]);
    focus.focused = true;
    // Refocused, and main re-broadcasts the same state: still nothing.
    receive({ ...agent, lastAgentStatus: "requires_input" }, NEEDS_INPUT);
    useAppStore.setState({ paneTitle: { "off-screen": "claude" } });
    expect(shown()).toEqual([]);
  });

  it("does not toast agents already waiting when the list was loaded", () => {
    const waiting = makeAgent({ id: "a1", paneId: "off-screen", lastAgentStatus: "requires_input" });
    useAgentStore.setState({ agents: [waiting], unseenInputAgentIds: new Set(["a1"]) });
    receive(waiting, NEEDS_INPUT);
    expect(shown()).toEqual([]);
  });

  it("toasts again on the next transition after it was resolved", () => {
    const agent = working("a1", "off-screen");
    receive({ ...agent, lastAgentStatus: "responded" }, RESPONDED);
    receive({ ...agent, lastAgentStatus: "working" }, RESPONDED);
    expect(shown()).toEqual([]);
    receive({ ...agent, lastAgentStatus: "responded" }, RESPONDED);
    expect(shown()).toEqual(["Agent responded"]);
  });
});
