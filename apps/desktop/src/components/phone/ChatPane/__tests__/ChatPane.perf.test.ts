// @vitest-environment jsdom
/**
 * How the phone chat holds up on a long session: the time to open on a long
 * history, and the time one live entry costs once it's open. A tool call
 * landing is the most common push in a working session, so that's the one
 * timed.
 *
 * jsdom does no layout or paint, so this measures React and markdown work
 * and the DOM's size. On 400 turns, before entries were memoized and
 * windowed: one push ~680ms, open ~1,000ms, 12.8k nodes. After: ~2ms,
 * ~120ms, and the same ~1.2k nodes whatever the length.
 *
 * The budgets are loose: they catch the history's length coming back into
 * the cost, not a few ms of drift.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { electronAPI: unknown }).electronAPI = { claim: null };
});

import type { ChatEntry, ChatPush } from "../../../../electron.d";
import { ChatPane } from "../ChatPane";

/** One push, any length. */
const PUSH_BUDGET_MS = 100;
/** Opening, any length. */
const OPEN_BUDGET_MS = 500;
/** The DOM the chat keeps, any length (the window mounts ~1.2k). */
const NODE_BUDGET = 2_000;

const PANE = "pane-perf";
const TRANSCRIPT = "/t/perf.jsonl";

/** A reply the size and shape of a real one: prose, a list, a code block. */
const REPLY = [
  "I looked at how the **stream** reads the transcript, and the offset only ever",
  "advances by complete lines, so a partial line is re-read once its newline lands.",
  "",
  "- `TranscriptStream` holds the byte offset",
  "- `mirror.ts` fans each push out to subscribers",
  "- the renderer upserts by id",
  "",
  "```ts",
  "const index = entries.findIndex((e) => e.id === entry.id);",
  "if (index === -1) return [...entries, entry];",
  "```",
  "",
  "Next I'll check the [docs](https://example.com/docs) and run the tests.",
].join("\n");

/** One turn: a prompt, a reply, a run of tool calls, a short wrap-up. */
function turn(i: number): ChatEntry[] {
  const ts = "2026-10-28T00:00:00.000Z";
  const tool = (n: number, name: string): ChatEntry => ({
    kind: "tool",
    id: `t${i}-${n}`,
    ts,
    name,
    summary: `src/components/file-${i}-${n}.ts`,
    status: "ok",
    detail: "line\n".repeat(40),
  });
  return [
    { kind: "user", id: `u${i}`, ts, text: `Please look at part ${i} of the codebase.` },
    { kind: "assistant", id: `a${i}`, ts, text: REPLY },
    tool(0, "Read"),
    tool(1, "Grep"),
    tool(2, "Bash"),
    tool(3, "Edit"),
    { kind: "assistant", id: `b${i}`, ts, text: `Done with part ${i}. The tests pass.` },
  ];
}

function session(turns: number): ChatEntry[] {
  return Array.from({ length: turns }, (_, i) => turn(i)).flat();
}

let container: HTMLDivElement;
let root: Root;
let push: ((paneId: string, entry: ChatPush) => void) | null;

function installChat(entries: ChatEntry[]): void {
  push = null;
  const chat = {
    getHistory: vi.fn(() => Promise.resolve({ ok: true, entries, contextTokens: null })),
    onEntry: vi.fn((_paneId: string, cb: typeof push) => {
      push = cb;
      return () => {
        push = null;
      };
    }),
    answer: vi.fn(),
    send: vi.fn(),
    interrupt: vi.fn(),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { claim: null, chat };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function measure(turns: number): Promise<{ entries: number; openMs: number; pushMs: number; nodes: number }> {
  const entries = session(turns);
  installChat(entries);
  const t0 = performance.now();
  await act(async () => {
    root.render(
      createElement(ChatPane, { paneId: PANE, transcript: TRANSCRIPT, hidden: false, onShowTerminal: () => {} }),
    );
  });
  const openMs = performance.now() - t0;

  const pushes: number[] = [];
  for (let n = 0; n < 15; n++) {
    const tool: ChatEntry = {
      kind: "tool",
      id: `live-${n}`,
      ts: new Date().toISOString(),
      name: "Bash",
      summary: "pnpm test",
      status: "pending",
    };
    const start = performance.now();
    await act(async () => push?.(PANE, tool));
    await act(async () => push?.(PANE, { ...tool, status: "ok" }));
    pushes.push((performance.now() - start) / 2);
  }
  const nodes = container.querySelectorAll("*").length;
  return { entries: entries.length, openMs, pushMs: median(pushes.slice(3)), nodes };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("phone chat on a long session", () => {
  it.each([50, 200, 400])("%i turns", async (turns) => {
    const r = await measure(turns);
    console.log(
      `[chat-perf] ${turns} turns, ${r.entries} entries: open ${r.openMs.toFixed(0)}ms, ` +
        `per push ${r.pushMs.toFixed(1)}ms, ${r.nodes} DOM nodes`,
    );
    expect(r.entries).toBe(turns * 7);
    expect(r.pushMs, "one live entry redrew the whole history").toBeLessThan(PUSH_BUDGET_MS);
    expect(r.openMs, "opening drew the whole history").toBeLessThan(OPEN_BUDGET_MS);
    expect(r.nodes, "the chat mounted the whole history").toBeLessThan(NODE_BUDGET);
  }, 120_000);
});
