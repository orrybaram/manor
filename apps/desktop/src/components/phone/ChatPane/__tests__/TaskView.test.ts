// @vitest-environment jsdom
/**
 * The chat's task view: the chip and a task's card open it without moving the
 * chat, in a side panel beside the chat on a desk and a single sheet on a
 * phone.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { electronAPI: unknown }).electronAPI = { claim: null };
});

import type { ChatEntry } from "../../../../electron.d";
import type { LayoutMode } from "../../../../hooks/useLayoutMode";
import { useAppStore } from "../../../../store/app-store";
import { ChatPane } from "../ChatPane";

// The pane's menu has its own e2e spec, and the rest of the app behind it.
vi.mock("../ChatPaneMenu", () => ({
  ChatPaneMenu: ({ children }: { children: unknown }) => children,
}));

const PANE = "pane-tasks";

function agent(id: string, over: Partial<Extract<ChatEntry, { kind: "task" }>> = {}): ChatEntry {
  return {
    kind: "task",
    id,
    ts: new Date().toISOString(),
    taskKind: "agent",
    title: `Agent ${id}`,
    agentType: "Explore",
    background: true,
    status: "running",
    hasTranscript: true,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;
let getTaskHistory: ReturnType<typeof vi.fn>;
let onTaskEntry: ReturnType<typeof vi.fn>;
let unsubscribeTask: ReturnType<typeof vi.fn>;
let scrollIntoView: ReturnType<typeof vi.fn>;
const interrupt = vi.fn(() => Promise.resolve());

function renderPane(layout: LayoutMode, hidden = false) {
  return act(async () => {
    root.render(
      createElement(ChatPane, {
        paneId: PANE,
        agentKind: "claude",
        transcript: "/t/tasks.jsonl",
        hidden,
        onShowTerminal: () => {},
        layout,
      }),
    );
  });
}

async function open(entries: ChatEntry[], layout: LayoutMode): Promise<void> {
  unsubscribeTask = vi.fn();
  getTaskHistory = vi.fn((_pane: string, id: string) =>
    Promise.resolve({
      ok: true,
      entries: [{ kind: "assistant", id: `${id}-reply`, ts: "", text: `Reply from ${id}` }],
      contextTokens: null,
    }),
  );
  onTaskEntry = vi.fn(() => unsubscribeTask);
  const chat = {
    getHistory: vi.fn(() => Promise.resolve({ ok: true, entries, contextTokens: null })),
    onEntry: vi.fn(() => () => {}),
    getTaskHistory,
    onTaskEntry,
    interrupt: interrupt,
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { claim: null, chat };
  await renderPane(layout);
}

const byId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
async function click(el: HTMLElement | null | undefined): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => el?.click());
}
const chip = () => byId("chat-agents-chip");
const panel = () => byId("chat-task-panel");
const sheet = () => byId("chat-agents-sheet");
const card = (id: string) =>
  document.body.querySelector<HTMLElement>(`[data-task-id="${id}"] button`);

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element["scrollIntoView"];
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("task view on a desk", () => {
  const three = () => [
    agent("one"),
    agent("two"),
    agent("three", { status: "ok", durationMs: 1_000 }),
  ];

  it("opens the newest running agent from the chip, without scrolling or a dialog", async () => {
    await open(three(), "desk");
    await click(chip());
    expect(panel()?.getAttribute("aria-label")).toBe("Agent two");
    expect(panel()?.textContent).toContain("Reply from two");
    expect(byId("chat-task-panel-count")?.textContent).toBe("2 of 3");
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(chip()?.getAttribute("aria-expanded")).toBe("true");
  });

  it("opens the newest agent once none run", async () => {
    await open(
      [agent("one", { status: "ok" }), agent("two", { status: "ok" })],
      "desk",
    );
    await click(chip());
    expect(panel()?.getAttribute("aria-label")).toBe("Agent two");
  });

  it("closes from the chip", async () => {
    await open(three(), "desk");
    await click(chip());
    await click(chip());
    expect(panel()).toBeNull();
  });

  it("opens a clicked card's agent and marks the card", async () => {
    await open(three(), "desk");
    await click(card("three"));
    expect(panel()?.getAttribute("aria-label")).toBe("Agent three");
    expect(document.body.querySelector('[data-task-id="three"]')?.hasAttribute("data-viewed")).toBe(true);
  });

  it("steps through the agents in chat order and watches only the one shown", async () => {
    await open(three(), "desk");
    await click(chip());
    await click(byId("chat-task-panel-next"));
    expect(panel()?.getAttribute("aria-label")).toBe("Agent three");
    expect(unsubscribeTask).toHaveBeenCalledOnce();
    await click(byId("chat-task-panel-next"));
    expect(panel()?.getAttribute("aria-label")).toBe("Agent one");
    await click(byId("chat-task-panel-previous"));
    expect(panel()?.getAttribute("aria-label")).toBe("Agent three");
    expect(unsubscribeTask).toHaveBeenCalledTimes(3);
  });

  it("has no arrows for a task that isn't a background agent", async () => {
    await open([agent("one"), agent("two"), agent("fg", { background: false, status: "ok" })], "desk");
    await click(card("fg"));
    expect(panel()?.getAttribute("aria-label")).toBe("Agent fg");
    expect(byId("chat-task-panel-next")).toBeNull();
  });

  it("closes on Escape from the composer first, and only the next Escape stops the agent", async () => {
    useAppStore.setState({ paneAgentStatus: { [PANE]: { status: "working", reason: "", kind: "claude" } } });
    interrupt.mockClear();
    await open(three(), "desk");
    await click(chip());
    const input = container.querySelector("textarea")!;
    const escape = () =>
      act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });
    await escape();
    expect(panel()).toBeNull();
    expect(interrupt).not.toHaveBeenCalled();
    await escape();
    expect(interrupt).toHaveBeenCalledOnce();
    useAppStore.setState({ paneAgentStatus: {} });
  });

  it("closes on Escape after a click in the chat, which focuses the chat body", async () => {
    await open(three(), "desk");
    await click(chip());
    const body = panel()!.parentElement!;
    expect(body.getAttribute("tabindex")).toBe("-1");
    await act(async () => {
      body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(panel()).toBeNull();
    expect(body.hasAttribute("tabindex")).toBe(false);
  });

  it("hands focus to the composer when it closes with focus inside", async () => {
    await open(three(), "desk");
    await click(chip());
    expect(document.activeElement).toBe(panel());
    await click(byId("chat-task-panel-close"));
    expect(document.activeElement).toBe(container.querySelector("textarea"));
  });

  it("leaves focus in another pane when it mounts", async () => {
    await open(three(), "desk");
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    await click(card("one"));
    expect(panel()).not.toBeNull();
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it("closes rather than becoming a sheet when the layout changes", async () => {
    await open(three(), "desk");
    await click(chip());
    await renderPane("phone");
    expect(panel()).toBeNull();
    expect(sheet()).toBeNull();
    await renderPane("desk");
    expect(panel()).toBeNull();
  });

  it("stops watching while the pane shows its terminal, and resumes after", async () => {
    await open(three(), "desk");
    await click(chip());
    expect(onTaskEntry).toHaveBeenCalledOnce();
    await renderPane("desk", true);
    expect(unsubscribeTask).toHaveBeenCalledOnce();
    await renderPane("desk", false);
    expect(onTaskEntry).toHaveBeenCalledTimes(2);
    expect(panel()?.textContent).toContain("Reply from two");
  });

  it("stops watching when closed", async () => {
    await open(three(), "desk");
    await click(chip());
    await click(byId("chat-task-panel-close"));
    expect(panel()).toBeNull();
    expect(unsubscribeTask).toHaveBeenCalledOnce();
  });

  it("shows the result of an agent with no transcript", async () => {
    await open([agent("one", { hasTranscript: false, status: "ok", result: "Found 3 readers." })], "desk");
    getTaskHistory.mockResolvedValue({ ok: false, reason: "no-transcript" });
    await click(chip());
    expect(panel()?.textContent).toContain("Found 3 readers.");
  });
});

describe("task view on a phone", () => {
  it("goes from the list to a transcript and back in one sheet", async () => {
    await open([agent("one"), agent("two")], "phone");
    await click(chip());
    expect(sheet()?.textContent).toContain("Background agents · 2 running");
    expect(sheet()?.querySelectorAll('[data-testid="chat-agent-row"]').length).toBe(2);
    expect(scrollIntoView).not.toHaveBeenCalled();

    await click(sheet()?.querySelector<HTMLElement>('[data-agent-id="two"]'));
    expect(sheet()?.textContent).toContain("Reply from two");
    expect(sheet()?.querySelector('[data-testid="chat-agent-row"]')).toBeNull();

    await click(byId("chat-agents-back"));
    expect(sheet()?.querySelectorAll('[data-testid="chat-agent-row"]').length).toBe(2);
    expect(panel()).toBeNull();
  });

  it("takes the sheet away when the pane shows its terminal", async () => {
    await open([agent("one")], "phone");
    await click(chip());
    expect(sheet()).not.toBeNull();
    await renderPane("phone", true);
    expect(sheet()).toBeNull();
  });

  it("skips the list with one agent", async () => {
    await open([agent("one")], "phone");
    await click(chip());
    expect(sheet()?.textContent).toContain("Reply from one");
    expect(byId("chat-agents-back")).toBeNull();
  });

  it("opens a tapped card's transcript in the sheet", async () => {
    await open([agent("one"), agent("two")], "phone");
    await click(card("one"));
    expect(sheet()?.textContent).toContain("Reply from one");
    expect(byId("chat-agents-back")).not.toBeNull();
  });

  it("ticks the running times in the list", async () => {
    vi.useFakeTimers();
    try {
      const ts = new Date(Date.now() - 60_000).toISOString();
      await open([agent("one", { ts }), agent("two", { ts })], "phone");
      await click(chip());
      const before = sheet()?.querySelector('[data-agent-id="one"]')?.textContent;
      await act(async () => vi.advanceTimersByTime(3_000));
      expect(sheet()?.querySelector('[data-agent-id="one"]')?.textContent).not.toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
