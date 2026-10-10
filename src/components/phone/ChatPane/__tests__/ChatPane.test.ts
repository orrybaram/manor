// @vitest-environment jsdom
/**
 * ADR-215 D7: the phone chat view. Entries render by kind; question cards
 * send the `PickerAnswer`s the user chose in one `chat.answer`; a refused
 * answer falls back to the terminal; and the Chat | Terminal choice defaults
 * to chat, is remembered per pane, and is shared by everything reading it.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { electronAPI: unknown }).electronAPI = { claim: null };
});

import type { ChatAnswerResult, ChatEntry, ChatHistory } from "../../../../electron.d";
import { ChatPane } from "../ChatPane";
import { setPaneChatView, usePaneChatView, usePaneChatViewStore } from "../usePaneChatView";
import { readChatView } from "../chat-view";
import { useAppStore } from "../../../../store/app-store";
import { useHostStore, type HostStatusInfo } from "../../../../store/host-store";

const PANE = "pane-1";

type EntryListener = (paneId: string, entry: ChatEntry) => void;

let container: HTMLDivElement;
let root: Root;
let listener: EntryListener | null;
let chat: {
  getHistory: ReturnType<typeof vi.fn>;
  onEntry: ReturnType<typeof vi.fn>;
  answer: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
};

function installChat(history: ChatHistory, answer: ChatAnswerResult = { ok: true }): void {
  listener = null;
  chat = {
    getHistory: vi.fn(() => Promise.resolve(history)),
    onEntry: vi.fn((_paneId: string, cb: EntryListener) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
    answer: vi.fn(() => Promise.resolve(answer)),
    send: vi.fn(() => Promise.resolve()),
    interrupt: vi.fn(() => Promise.resolve()),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { claim: null, chat };
}

const question = (
  id: string,
  questions: { multiSelect: boolean; header: string }[],
): Extract<ChatEntry, { kind: "question" }> => ({
  kind: "question",
  id,
  ts: "",
  answer: null,
  questions: questions.map((q) => ({
    question: `${q.header}?`,
    header: q.header,
    multiSelect: q.multiSelect,
    options: [
      { label: "Alpha", description: "first" },
      { label: "Beta", description: "second" },
      { label: "Gamma", description: "" },
    ],
  })),
});

async function renderChat(onShowTerminal = vi.fn()): Promise<typeof onShowTerminal> {
  await act(async () => {
    root.render(createElement(ChatPane, { paneId: PANE, hidden: false, onShowTerminal }));
  });
  return onShowTerminal;
}

function all(testId: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
}

async function click(el: Element | undefined): Promise<void> {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function optionNamed(label: string, card: Element = container): HTMLElement | undefined {
  return [...card.querySelectorAll<HTMLElement>('[data-testid="chat-question-option"]')].find(
    (b) => b.textContent?.startsWith(label),
  );
}

/** React tracks input values itself; set it the way a keystroke does. */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  localStorage.clear();
  useAppStore.setState({ paneAgentStatus: {} });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("ChatPane — entries", () => {
  it("subscribes before fetching, and renders each kind", async () => {
    installChat({
      ok: true,
      entries: [
        { kind: "user", id: "u1", ts: "", text: "hello there" },
        { kind: "assistant", id: "a1", ts: "", text: "Some **bold** words" },
        {
          kind: "tool",
          id: "t1",
          ts: "",
          name: "Bash",
          summary: "List files",
          status: "ok",
          detail: "a.txt\nb.txt",
        },
        { ...question("q0", [{ multiSelect: false, header: "Old" }]), answer: "Alpha" },
      ],
    });
    await renderChat();

    expect(chat.onEntry.mock.invocationCallOrder[0]).toBeLessThan(
      chat.getHistory.mock.invocationCallOrder[0],
    );
    expect(all("chat-user")[0].textContent).toBe("hello there");
    expect(all("chat-assistant")[0].querySelector("strong")?.textContent).toBe("bold");
    const tool = all("chat-tool")[0];
    expect(tool.textContent).toContain("Bash");
    expect(tool.textContent).toContain("List files");
    expect(tool.querySelector("pre")).toBeNull();
    await click(tool.querySelector("button")!);
    expect(tool.querySelector("pre")?.textContent).toBe("a.txt\nb.txt");
    expect(all("chat-question-answered")[0].textContent).toContain("Alpha");
  });

  it("upserts live entries by id", async () => {
    installChat({ ok: true, entries: [] });
    await renderChat();
    const pending: ChatEntry = { kind: "tool", id: "t1", ts: "", name: "Read", summary: "x", status: "pending" };
    await act(async () => listener?.(PANE, pending));
    await act(async () => listener?.(PANE, { ...pending, status: "error" }));
    const tools = all("chat-tool");
    expect(tools).toHaveLength(1);
    expect(tools[0].dataset.status).toBe("error");
  });

  it("shows a note and a way to the terminal when there is no chat", async () => {
    installChat({ ok: false, reason: "no-transcript" });
    const onShowTerminal = await renderChat();
    expect(all("chat-unavailable")).toHaveLength(1);
    await click(all("chat-unavailable")[0].querySelector("button")!);
    expect(onShowTerminal).toHaveBeenCalledTimes(1);
  });

  it("shows the needs-you banner only with no answerable picker", async () => {
    installChat({ ok: true, entries: [] });
    useAppStore.setState({ paneAgentStatus: { [PANE]: { status: "requires_input", reason: "", kind: "claude" } } });
    await renderChat();
    expect(all("chat-needs-you")).toHaveLength(1);
    await act(async () => listener?.(PANE, question("q1", [{ multiSelect: false, header: "H" }])));
    expect(all("chat-needs-you")).toHaveLength(0);
  });

  it("offers Stop while Claude is working", async () => {
    installChat({ ok: true, entries: [] });
    useAppStore.setState({ paneAgentStatus: { [PANE]: { status: "working", reason: "", kind: "claude" } } });
    await renderChat();
    await click(all("chat-stop")[0]);
    expect(chat.interrupt).toHaveBeenCalledWith(PANE);
  });
});

describe("ChatPane — question cards", () => {
  it("single question: a tap answers it", async () => {
    installChat({ ok: true, entries: [question("q1", [{ multiSelect: false, header: "H" }])] });
    await renderChat();
    await click(optionNamed("Beta"));
    expect(chat.answer).toHaveBeenCalledWith(PANE, "q1", {
      kind: "question",
      answers: [{ kind: "option", indexes: [1] }],
    });
    // Disabled while waiting for Claude: a second tap sends nothing.
    await click(optionNamed("Alpha"));
    expect(chat.answer).toHaveBeenCalledTimes(1);
  });

  it("multi-select: toggles, then Submit", async () => {
    installChat({ ok: true, entries: [question("q1", [{ multiSelect: true, header: "H" }])] });
    await renderChat();
    expect(all("chat-question-other")).toHaveLength(0);
    await click(optionNamed("Gamma"));
    await click(optionNamed("Alpha"));
    expect(chat.answer).not.toHaveBeenCalled();
    await click(all("chat-question-submit")[0]);
    expect(chat.answer).toHaveBeenCalledWith(PANE, "q1", {
      kind: "question",
      answers: [{ kind: "option", indexes: [0, 2] }],
    });
  });

  it("other: reveals a field, and Submit sends its text", async () => {
    installChat({ ok: true, entries: [question("q1", [{ multiSelect: false, header: "H" }])] });
    await renderChat();
    await click(all("chat-question-other")[0]);
    const input = all("chat-question-other-input")[0] as HTMLInputElement;
    await typeInto(input, "Delta please");
    await click(all("chat-question-submit")[0]);
    expect(chat.answer).toHaveBeenCalledWith(PANE, "q1", {
      kind: "question",
      answers: [{ kind: "other", text: "Delta please" }],
    });
  });

  it("two questions: collects both, then sends one answer", async () => {
    installChat({
      ok: true,
      entries: [
        question("q1", [
          { multiSelect: false, header: "First" },
          { multiSelect: true, header: "Second" },
        ]),
      ],
    });
    await renderChat();
    const blocks = [...container.querySelectorAll('[role="group"]')];
    await click(optionNamed("Gamma", blocks[0]));
    const submit = all("chat-question-submit")[0] as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await click(optionNamed("Beta", blocks[1]));
    expect(submit.disabled).toBe(false);
    await click(submit);
    expect(chat.answer).toHaveBeenCalledTimes(1);
    expect(chat.answer).toHaveBeenCalledWith(PANE, "q1", {
      kind: "question",
      answers: [
        { kind: "option", indexes: [2] },
        { kind: "option", indexes: [1] },
      ],
    });
  });

  it("stale: falls back to the terminal", async () => {
    installChat(
      { ok: true, entries: [question("q1", [{ multiSelect: false, header: "H" }])] },
      { ok: false, reason: "stale" },
    );
    const onShowTerminal = await renderChat();
    await click(optionNamed("Alpha"));
    const fallback = all("chat-answer-in-terminal");
    expect(fallback).toHaveLength(1);
    await click(fallback[0].querySelector("button")!);
    expect(onShowTerminal).toHaveBeenCalledTimes(1);
  });

  it("needsTerminal and older open pickers go to the terminal without sending", async () => {
    installChat({
      ok: true,
      entries: [
        question("old", [{ multiSelect: false, header: "Old" }]),
        { ...question("q1", [{ multiSelect: false, header: "H" }]), needsTerminal: true },
      ],
    });
    await renderChat();
    expect(all("chat-answer-in-terminal")).toHaveLength(2);
    await click(optionNamed("Alpha"));
    expect(chat.answer).not.toHaveBeenCalled();
  });

  it("plan: Approve sends plan-approve; Change plan opens the terminal", async () => {
    installChat({ ok: true, entries: [{ kind: "plan", id: "p1", ts: "", plan: "1. Do it", outcome: null }] });
    const onShowTerminal = await renderChat();
    await click(all("chat-plan-change")[0]);
    expect(onShowTerminal).toHaveBeenCalledTimes(1);
    await click(all("chat-plan-approve")[0]);
    expect(chat.answer).toHaveBeenCalledWith(PANE, "p1", { kind: "plan-approve" });
  });
});

describe("pane view store", () => {
  beforeEach(() => {
    usePaneChatViewStore.setState({ views: {} });
  });

  /** Two readers of one pane, as `LeafPane` and the top bar's menu are. */
  function Harness() {
    const [a] = usePaneChatView(PANE);
    const [b, setB] = usePaneChatView(PANE);
    return createElement(
      "button",
      { "data-testid": "flip", "data-a": a, "data-b": b, onClick: () => setB(b === "chat" ? "terminal" : "chat") },
    );
  }

  function views(): [string | null, string | null] {
    const el = container.querySelector('[data-testid="flip"]');
    return [el?.getAttribute("data-a") ?? null, el?.getAttribute("data-b") ?? null];
  }

  it("defaults to chat, is shared by every reader, and remembers the choice per pane", async () => {
    await act(async () => {
      root.render(createElement(Harness));
    });
    expect(views()).toEqual(["chat", "chat"]);
    await click(container.querySelector('[data-testid="flip"]')!);
    expect(views()).toEqual(["terminal", "terminal"]);
    expect(readChatView(PANE)).toBe("terminal");
    expect(readChatView("another-pane")).toBe("chat");

    // A fresh store (a reload) reads the choice back from storage.
    usePaneChatViewStore.setState({ views: {} });
    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(Harness));
    });
    expect(views()).toEqual(["terminal", "terminal"]);
  });

  it("re-renders a reader when the view is set from outside it", async () => {
    await act(async () => {
      root.render(createElement(Harness));
    });
    await act(async () => {
      setPaneChatView(PANE, "terminal");
    });
    expect(views()).toEqual(["terminal", "terminal"]);
  });

  it("falls back to chat when storage throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readChatView(PANE)).toBe("chat");
    spy.mockRestore();
  });
});

describe("ChatPane — host offline (ADR-216 D4)", () => {
  const OFFLINE: ChatHistory = { ok: false, reason: "host-offline" };
  const BACK: ChatHistory = {
    ok: true,
    entries: [{ kind: "user", id: "u1", ts: "", text: "from before" }],
  };

  afterEach(() => {
    vi.useRealTimers();
    useHostStore.setState({ hosts: [] });
  });

  it("says the host is offline, with a way to the terminal", async () => {
    installChat(OFFLINE);
    await renderChat();
    expect(all("chat-unavailable")[0].textContent).toContain(
      "This host is offline. The chat will catch up when it reconnects.",
    );
    expect(all("chat-unavailable")[0].querySelector("button")?.textContent).toBe("Show terminal");
  });

  it("refetches and shows the chat again when the next entry arrives", async () => {
    installChat(OFFLINE);
    await renderChat();
    chat.getHistory.mockImplementation(() => Promise.resolve(BACK));
    await act(async () => listener?.(PANE, { kind: "user", id: "u2", ts: "", text: "new" }));
    expect(chat.getHistory).toHaveBeenCalledTimes(2);
    expect(all("chat-unavailable")).toHaveLength(0);
    expect(all("chat-user").map((e) => e.textContent)).toEqual(["from before", "new"]);
  });

  it("refetches when a host's status changes, and stays put while still offline", async () => {
    installChat(OFFLINE);
    await renderChat();
    const host = { hostId: "devbox", status: "reconnecting" } as HostStatusInfo;
    await act(async () => useHostStore.setState({ hosts: [host] }));
    expect(chat.getHistory).toHaveBeenCalledTimes(2);
    expect(all("chat-unavailable")).toHaveLength(1);

    chat.getHistory.mockImplementation(() => Promise.resolve(BACK));
    await act(async () => useHostStore.setState({ hosts: [{ ...host, status: "connected" }] }));
    expect(chat.getHistory).toHaveBeenCalledTimes(3);
    expect(all("chat-unavailable")).toHaveLength(0);
    expect(all("chat-user")[0].textContent).toBe("from before");

    // Back: host changes no longer refetch.
    await act(async () => useHostStore.setState({ hosts: [] }));
    expect(chat.getHistory).toHaveBeenCalledTimes(3);
  });

  it("retries on its own while offline, and stops once back", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    installChat(OFFLINE);
    await renderChat();
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(chat.getHistory).toHaveBeenCalledTimes(2);

    chat.getHistory.mockImplementation(() => Promise.resolve(BACK));
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(all("chat-unavailable")).toHaveLength(0);
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(chat.getHistory).toHaveBeenCalledTimes(3);
  });
});
