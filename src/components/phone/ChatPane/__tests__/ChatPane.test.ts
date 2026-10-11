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
import { BUILTIN_COMMANDS } from "../../../../../electron/chat-mirror/builtin-commands";
import { ChatPane } from "../ChatPane";
import {
  endMenuHandoff,
  noteChatEntries,
  selectPaneChatView,
  setPaneChatView,
  startMenuHandoff,
  usePaneChatView,
  usePaneChatViewStore,
} from "../usePaneChatView";
import { readChatView } from "../chat-view";
import { useAppStore } from "../../../../store/app-store";
import { useHostStore, type HostStatusInfo } from "../../../../store/host-store";
import { emitBridgeResync } from "../../../../bridge/resync";

const PANE = "pane-1";
const TRANSCRIPT = "/t/a.jsonl";

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
    root.render(createElement(ChatPane, { paneId: PANE, transcript: TRANSCRIPT, hidden: false, onShowTerminal }));
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
async function typeInto(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
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
    const group = all("chat-tool-group")[0];
    expect(group.textContent).toBe("Ran a command");
    expect(all("chat-tool")).toHaveLength(0);
    await click(group.querySelector("button")!);
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
    const groups = all("chat-tool-group");
    expect(groups).toHaveLength(1);
    expect(groups[0].dataset.status).toBe("error");
    expect(groups[0].textContent).toBe("Read a file (1 failed)");
  });

  it("folds back-to-back tool calls into one line, showing the running call", async () => {
    installChat({ ok: true, entries: [] });
    await renderChat();
    const tool = (id: string, name: string, status: "pending" | "ok"): ChatEntry => ({
      kind: "tool",
      id,
      ts: new Date().toISOString(),
      name,
      summary: `${name} ${id}`,
      status,
    });
    await act(async () => listener?.(PANE, tool("t1", "Bash", "ok")));
    await act(async () => listener?.(PANE, tool("t2", "Read", "pending")));
    let groups = all("chat-tool-group");
    expect(groups).toHaveLength(1);
    expect(groups[0].dataset.status).toBe("pending");
    expect(groups[0].textContent).toContain("Read t2");

    await act(async () => listener?.(PANE, tool("t2", "Read", "ok")));
    await act(async () => listener?.(PANE, { kind: "assistant", id: "a1", ts: "", text: "Done." }));
    await act(async () => listener?.(PANE, tool("t3", "Bash", "ok")));
    groups = all("chat-tool-group");
    expect(groups.map((g) => g.textContent)).toEqual(["Ran a command, read a file", "Ran a command"]);
  });

  it("shows Thinking while Claude works with nothing to show", async () => {
    vi.useFakeTimers();
    try {
      installChat({ ok: true, entries: [] });
      useAppStore.setState({ paneAgentStatus: { [PANE]: { status: "thinking", reason: "", kind: "claude" } } });
      await renderChat();
      expect(all("chat-thinking")).toHaveLength(0);
      await act(async () => vi.advanceTimersByTime(800));
      expect(all("chat-thinking")[0].textContent).toBe("Thinking0s");

      const pending: ChatEntry = { kind: "tool", id: "t1", ts: "", name: "Bash", summary: "ls", status: "pending" };
      await act(async () => listener?.(PANE, pending));
      await act(async () => vi.advanceTimersByTime(800));
      expect(all("chat-thinking")).toHaveLength(0);

      await act(async () => listener?.(PANE, { ...pending, status: "ok" }));
      await act(async () => vi.advanceTimersByTime(2200));
      expect(all("chat-thinking")[0].textContent).toBe("Thinking2s");

      useAppStore.setState({ paneAgentStatus: { [PANE]: { status: "idle", reason: "", kind: "claude" } } });
      await act(async () => {});
      expect(all("chat-thinking")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
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
    expect(all("chat-send")).toHaveLength(0);
    await click(all("chat-stop")[0]);
    expect(chat.interrupt).toHaveBeenCalledWith(PANE);
  });

  it("typing mid-turn turns Stop back into Send, with Stop beside it", async () => {
    installChat({ ok: true, entries: [] });
    useAppStore.setState({ paneAgentStatus: { [PANE]: { status: "working", reason: "", kind: "claude" } } });
    await renderChat();
    await typeInto(all("chat-composer-input")[0] as HTMLTextAreaElement, "and then this");
    expect(all("chat-send")).toHaveLength(1);
    expect((all("chat-send")[0] as HTMLButtonElement).disabled).toBe(false);
    expect(all("chat-stop")).toHaveLength(1);
    await click(all("chat-stop")[0]);
    expect(chat.interrupt).toHaveBeenCalledWith(PANE);
  });

  it("sending /clear leaves this transcript behind for a fresh chat", async () => {
    usePaneChatViewStore.setState({ starting: {} });
    installChat({ ok: true, entries: [] });
    Object.assign(chat, {
      getCommands: vi.fn(() => Promise.resolve({ ok: false, reason: "no-agent" })),
    });
    await renderChat();
    await typeInto(all("chat-composer-input")[0] as HTMLTextAreaElement, "/clear");
    await click(all("chat-send")[0]);
    expect(chat.send).toHaveBeenCalledWith(PANE, "/clear");
    expect(usePaneChatViewStore.getState().starting).toEqual({ [PANE]: "/t/a.jsonl" });
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
    const [a] = usePaneChatView(PANE, TRANSCRIPT);
    const [b, setB] = usePaneChatView(PANE, TRANSCRIPT);
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

describe("menu handoff (ADR-218 D3)", () => {
  beforeEach(() => {
    usePaneChatViewStore.setState({ views: {}, starting: {}, handoffs: {} });
  });

  /** What `LeafPane` shows for the pane, while on `transcript`. */
  const view = (transcript: string | null = TRANSCRIPT) =>
    selectPaneChatView(usePaneChatViewStore.getState(), PANE, transcript);
  const handoffs = () => usePaneChatViewStore.getState().handoffs;

  it("start records the command and its transcript, and covers the view with the terminal", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    startMenuHandoff(PANE, "config", TRANSCRIPT);
    vi.mocked(Date.now).mockRestore();
    expect(handoffs()).toEqual({
      [PANE]: { name: "config", startedAt: 1_000, transcript: TRANSCRIPT },
    });
    expect(view()).toBe("terminal");
  });

  it("never touches the stored view, so a reload mid-handoff comes back on the chat", () => {
    startMenuHandoff(PANE, "config", TRANSCRIPT);
    expect(usePaneChatViewStore.getState().views[PANE]).toBeUndefined();
    expect(readChatView(PANE)).toBe("chat");

    // A reload: a fresh store, with no handoff in memory.
    usePaneChatViewStore.setState({ views: {}, starting: {}, handoffs: {} });
    expect(view()).toBe("chat");
  });

  it("end reveals the stored view underneath", () => {
    startMenuHandoff(PANE, "config", TRANSCRIPT);
    endMenuHandoff(PANE);
    expect(handoffs()).toEqual({});
    expect(view()).toBe("chat");
  });

  it("end without a handoff leaves a chosen terminal alone", () => {
    setPaneChatView(PANE, "terminal");
    endMenuHandoff(PANE);
    expect(view()).toBe("terminal");
  });

  it("a new transcript ends it", () => {
    startMenuHandoff(PANE, "resume", TRANSCRIPT);
    expect(view("/t/b.jsonl")).toBe("chat");

    // The new transcript's chat drops it from the store as well.
    noteChatEntries(PANE, "/t/b.jsonl", []);
    expect(handoffs()).toEqual({});
    expect(view()).toBe("chat");
  });

  it("from a fresh chat, it is on the transcript the pane is leaving", () => {
    usePaneChatViewStore.setState({ starting: { [PANE]: TRANSCRIPT } });
    startMenuHandoff(PANE, "config", null);
    expect(handoffs()[PANE]?.transcript).toBe(TRANSCRIPT);
    expect(view()).toBe("terminal");
  });

  async function sendBareConfig(): Promise<void> {
    Object.assign(chat, {
      getCommands: vi.fn(() => Promise.resolve({ ok: false, reason: "no-agent" })),
    });
    await renderChat();
    await typeInto(all("chat-composer-input")[0] as HTMLTextAreaElement, "/config");
    await click(all("chat-send")[0]);
  }

  it("a bare menu command hands off, and its transcript line brings the chat back", async () => {
    installChat({ ok: true, entries: [] });
    await sendBareConfig();
    expect(chat.send).toHaveBeenCalledWith(PANE, "/config");
    expect(handoffs()[PANE]).toMatchObject({ name: "config", transcript: TRANSCRIPT });
    expect(view()).toBe("terminal");

    // Another command, or the menu's own command from before, keeps it.
    const now = Date.now();
    const at = (ms: number) => new Date(ms).toISOString();
    await act(async () =>
      listener?.(PANE, { kind: "command", id: "c0", ts: at(now), name: "model", args: "" }),
    );
    await act(async () =>
      listener?.(PANE, { kind: "command", id: "c1", ts: at(now - 60_000), name: "config", args: "" }),
    );
    expect(view()).toBe("terminal");

    await act(async () =>
      listener?.(PANE, { kind: "command", id: "c2", ts: at(now + 5_000), name: "config", args: "" }),
    );
    expect(handoffs()).toEqual({});
    expect(view()).toBe("chat");
  });

  it("a command with an argument that skips the menu stays on the chat", async () => {
    installChat({ ok: true, entries: [] });
    Object.assign(chat, {
      getCommands: vi.fn(() => Promise.resolve({ ok: false, reason: "no-agent" })),
    });
    await renderChat();
    await typeInto(all("chat-composer-input")[0] as HTMLTextAreaElement, "/model sonnet");
    await click(all("chat-send")[0]);
    expect(chat.send).toHaveBeenCalledWith(PANE, "/model sonnet");
    expect(handoffs()).toEqual({});
  });
});

describe("ChatPane — choice sheet (ADR-218 D2)", () => {
  const view = () => selectPaneChatView(usePaneChatViewStore.getState(), PANE, TRANSCRIPT);

  beforeEach(() => {
    usePaneChatViewStore.setState({ views: {}, handoffs: {} });
    // jsdom has no layout, so no scrollIntoView.
    Element.prototype.scrollIntoView = vi.fn();
  });

  async function openSheet(): Promise<HTMLTextAreaElement> {
    installChat({ ok: true, entries: [] });
    Object.assign(chat, {
      getCommands: vi.fn(() =>
        Promise.resolve({ ok: true, skillsKnown: true, commands: BUILTIN_COMMANDS }),
      ),
    });
    await renderChat();
    const input = all("chat-composer-input")[0] as HTMLTextAreaElement;
    await typeInto(input, "/model");
    await click(container.querySelector('[data-command="model"]') ?? undefined);
    return input;
  }

  it("picking /model opens the sheet, and a choice sends it without leaving the chat", async () => {
    const input = await openSheet();
    expect(all("command-choice-sheet")).toHaveLength(1);
    expect(all("slash-command-menu")).toHaveLength(0);
    expect(input.value).toBe("/model");

    await click(all("command-choice-sonnet")[0]);
    expect(chat.send).toHaveBeenCalledWith(PANE, "/model sonnet");
    expect(all("command-choice-sheet")).toHaveLength(0);
    expect(input.value).toBe("");
    expect(view()).toBe("chat");
  });

  it("Other prefills the command", async () => {
    const input = await openSheet();
    await click(all("command-choice-other")[0]);
    expect(all("command-choice-sheet")).toHaveLength(0);
    expect(input.value).toBe("/model ");
    expect(chat.send).not.toHaveBeenCalled();
  });

  it("Open menu in terminal sends the bare command and hands off", async () => {
    await openSheet();
    await click(all("command-choice-terminal")[0]);
    expect(chat.send).toHaveBeenCalledWith(PANE, "/model");
    expect(usePaneChatViewStore.getState().handoffs[PANE]?.name).toBe("model");
    expect(view()).toBe("terminal");
  });

  it("arrows and Enter pick, and Esc closes without sending", async () => {
    const input = await openSheet();
    const key = (k: string) =>
      act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
      });
    await key("ArrowDown");
    await key("Enter");
    expect(chat.send).toHaveBeenCalledWith(PANE, "/model fable");

    chat.send.mockClear();
    await typeInto(input, "/model");
    await click(container.querySelector('[data-command="model"]') ?? undefined);
    await key("Escape");
    expect(all("command-choice-sheet")).toHaveLength(0);
    expect(chat.send).not.toHaveBeenCalled();
    expect(input.value).toBe("/model");
  });

  const keyOn = (input: HTMLElement, k: string) =>
    act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    });

  it("dismissing the sheet keeps the / menu shut, and any edit reopens it", async () => {
    const input = await openSheet();
    await keyOn(input, "Escape");
    expect(all("command-choice-sheet")).toHaveLength(0);
    expect(all("slash-command-menu")).toHaveLength(0);

    await typeInto(input, "/mode");
    expect(all("slash-command-menu")).toHaveLength(1);
  });

  it("a tap outside the sheet dismisses it the same way", async () => {
    await openSheet();
    await act(async () => {
      // The backdrop, drawn just before the sheet.
      all("command-choice-sheet")[0]
        .previousElementSibling?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(all("command-choice-sheet")).toHaveLength(0);
    expect(all("slash-command-menu")).toHaveLength(0);
  });

  it("the textarea's aria follows whichever listbox is showing", async () => {
    const input = await openSheet();
    const sheetList = all("command-choice-sheet")[0].querySelector('[role="listbox"]');
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBe(sheetList?.id);
    expect(input.getAttribute("aria-activedescendant")).toBe(
      all("command-choice-default")[0].id,
    );
    await keyOn(input, "ArrowUp");
    expect(input.getAttribute("aria-activedescendant")).toBe(
      all("command-choice-terminal")[0].id,
    );

    await keyOn(input, "Escape");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("aria-controls")).toBeNull();
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
  });

  it("Tab completes a command, and does nothing on the sheet", async () => {
    const input = await openSheet();
    await keyOn(input, "Tab");
    expect(all("command-choice-sheet")).toHaveLength(1);
    expect(chat.send).not.toHaveBeenCalled();

    await typeInto(input, "/clea");
    expect(all("command-choice-sheet")).toHaveLength(0);
    await keyOn(input, "Tab");
    expect(input.value).toBe("/clear ");
    expect(all("slash-command-menu")).toHaveLength(0);
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

describe("ChatPane — bridge resync (ADR-220 D3)", () => {
  it("fetches history again and merges what was missed", async () => {
    installChat({ ok: true, entries: [{ kind: "user", id: "u1", ts: "", text: "before" }] });
    await renderChat();
    await act(async () => listener?.(PANE, { kind: "assistant", id: "a1", ts: "", text: "live" }));

    chat.getHistory.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        entries: [
          { kind: "user", id: "u1", ts: "", text: "before" },
          { kind: "assistant", id: "a1", ts: "", text: "live" },
          { kind: "user", id: "u2", ts: "", text: "missed" },
        ],
      }),
    );
    await act(async () => emitBridgeResync());
    expect(chat.getHistory).toHaveBeenCalledTimes(2);
    expect(all("chat-user").map((e) => e.textContent)).toEqual(["before", "missed"]);
    expect(all("chat-assistant")).toHaveLength(1);
  });

  it("keeps the chat when the refetch fails, and stops listening once unmounted", async () => {
    installChat({ ok: true, entries: [{ kind: "user", id: "u1", ts: "", text: "before" }] });
    await renderChat();
    chat.getHistory.mockImplementation(() => Promise.reject(new Error("dropped")));
    await act(async () => emitBridgeResync());
    expect(all("chat-unavailable")).toHaveLength(0);
    expect(all("chat-user")[0].textContent).toBe("before");

    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    emitBridgeResync();
    expect(chat.getHistory).toHaveBeenCalledTimes(2);
  });

  it("refetches slash commands it already has on the next open, and not ones it never fetched", async () => {
    installChat({ ok: true, entries: [] });
    const getCommands = vi.fn(() =>
      Promise.resolve({ ok: true, skillsKnown: true, commands: BUILTIN_COMMANDS }),
    );
    Object.assign(chat, { getCommands });
    await renderChat();
    await act(async () => emitBridgeResync());
    expect(getCommands).not.toHaveBeenCalled();

    const input = all("chat-composer-input")[0] as HTMLTextAreaElement;
    await typeInto(input, "/mo");
    expect(getCommands).toHaveBeenCalledTimes(1);
    // A fresh list is not refetched on reopening.
    await typeInto(input, "");
    await typeInto(input, "/mo");
    expect(getCommands).toHaveBeenCalledTimes(1);

    // The resync marks it stale; the next open refetches it.
    await act(async () => emitBridgeResync());
    expect(getCommands).toHaveBeenCalledTimes(1);
    await typeInto(input, "");
    await typeInto(input, "/mo");
    expect(getCommands).toHaveBeenCalledTimes(2);
  });
});
