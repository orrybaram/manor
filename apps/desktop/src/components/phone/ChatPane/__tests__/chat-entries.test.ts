/**
 * Runs of tool calls fold into one group, summed up as a sentence.
 */
import { describe, expect, it } from "vitest";
import type { ChatEntry, ChatTaskEntry } from "../../../../electron.d";
import {
  chatTasks,
  formatDuration,
  formatElapsed,
  groupEntries,
  newestContent,
  resultPreview,
  sameItem,
  splitPrompt,
  staleTaskIds,
  summarizeTools,
} from "../chat-entries";

type Tool = Extract<ChatEntry, { kind: "tool" }>;

const tool = (id: string, name: string, status: Tool["status"] = "ok"): Tool => ({
  kind: "tool",
  id,
  ts: "",
  name,
  summary: id,
  status,
});

describe("groupEntries", () => {
  it("folds each run of tool calls into a group keyed by its first call", () => {
    const items = groupEntries([
      tool("t1", "Bash"),
      tool("t2", "Read"),
      { kind: "assistant", id: "a1", ts: "", text: "hi" },
      tool("t3", "Bash"),
    ]);
    expect(items.map((i) => [i.kind, i.id])).toEqual([
      ["tool-group", "t1"],
      ["assistant", "a1"],
      ["tool-group", "t3"],
    ]);
    expect(items[0].kind === "tool-group" && items[0].tools.map((t) => t.id)).toEqual(["t1", "t2"]);
  });
});

describe("groupEntries with timing lines", () => {
  const thought = (id: string): ChatEntry => ({ kind: "thought", id, ts: "", durationMs: 3000 });
  const turnEnd = (id: string): ChatEntry => ({
    kind: "turn-end",
    id,
    ts: "",
    durationMs: 9000,
    backgroundAgents: 0,
  });

  it("keeps a run of tool calls one group across the thoughts between them", () => {
    const items = groupEntries([
      thought("th1"),
      tool("t1", "Bash"),
      thought("th2"),
      tool("t2", "Read"),
      thought("th3"),
      { kind: "assistant", id: "a1", ts: "", text: "done" },
      turnEnd("e1"),
    ]);
    expect(items.map((i) => [i.kind, i.id])).toEqual([
      ["thought", "th1"],
      ["tool-group", "t1"],
      ["thought", "th3"],
      ["assistant", "a1"],
      ["turn-end", "e1"],
    ]);
    expect(items[1].kind === "tool-group" && items[1].tools.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("holds back a thought after a run while nothing has followed it yet", () => {
    // Its tool call usually lands next and would fold it away again.
    const items = groupEntries([tool("t1", "Bash"), thought("th1")]);
    expect(items.map((i) => i.kind)).toEqual(["tool-group"]);
  });

  it("shows a thought after a run once text follows it", () => {
    const text: ChatEntry = { kind: "assistant", id: "a1", ts: "", text: "done" };
    const items = groupEntries([tool("t1", "Bash"), thought("th1"), text]);
    expect(items.map((i) => i.kind)).toEqual(["tool-group", "thought", "assistant"]);
  });

  it("ends a run at a turn-end", () => {
    const items = groupEntries([tool("t1", "Bash"), turnEnd("e1"), tool("t2", "Bash")]);
    expect(items.map((i) => [i.kind, i.id])).toEqual([
      ["tool-group", "t1"],
      ["turn-end", "e1"],
      ["tool-group", "t2"],
    ]);
  });

  it("finds the newest item that isn't a timing line", () => {
    const items = groupEntries([tool("t1", "Bash", "pending"), thought("th1"), turnEnd("e1")]);
    expect(newestContent(items)?.id).toBe("t1");
    expect(newestContent(groupEntries([thought("th1")]))).toBeUndefined();
  });
});

describe("groupEntries with edits", () => {
  const edit = (id: string): ChatEntry => ({
    kind: "edit",
    id,
    ts: "",
    name: "Edit",
    path: "src/a.ts",
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }],
    added: 1,
    removed: 1,
    truncated: false,
  });

  it("draws a landed edit as its own card, ending the tool run", () => {
    const items = groupEntries([tool("t1", "Read"), edit("t2"), tool("t3", "Bash"), tool("t4", "Edit", "error")]);
    expect(items.map((i) => [i.kind, i.id])).toEqual([
      ["tool-group", "t1"],
      ["edit", "t2"],
      ["tool-group", "t3"],
    ]);
    // The landed edit isn't counted again; the failed one still is.
    expect(items[2].kind === "tool-group" && summarizeTools(items[2].tools).map((p) => p.text)).toEqual([
      "Ran a command",
      "edited a file",
    ]);
  });
});

describe("summarizeTools", () => {
  const text = (tools: Tool[]) =>
    summarizeTools(tools)
      .map((p) => p.text + (p.failed ? ` (${p.failed} failed)` : ""))
      .join(", ");

  it("phrases Codex's calls as Claude's are", () => {
    expect(
      text([
        tool("1", "shell"),
        tool("2", "shell", "error"),
        tool("3", "apply_patch", "error"),
        tool("4", "web_search"),
        tool("5", "update_plan"),
      ]),
    ).toBe("Ran 2 commands (1 failed), edited a file (1 failed), searched the web, updated the plan");
  });

  it("counts each kind in the order it first appears", () => {
    expect(
      text([tool("1", "Bash", "error"), tool("2", "Read"), tool("3", "Bash"), tool("4", "Edit")]),
    ).toBe("Ran 2 commands (1 failed), read a file, edited a file");
  });

  it("uses 'an' and fixed phrases where they read better", () => {
    expect(text([tool("1", "Agent"), tool("2", "Grep"), tool("3", "Glob"), tool("4", "WebFetch")])).toBe(
      "Ran an agent, searched the code, searched the web",
    );
  });

  it("calls anything unknown a tool", () => {
    expect(text([tool("1", "mcp__manor__list_panes"), tool("2", "Skill")])).toBe("Used 2 tools");
  });
});

const task = (id: string, status: ChatTaskEntry["status"] = "running"): ChatTaskEntry => ({
  kind: "task",
  id,
  ts: "",
  taskKind: "agent",
  title: id,
  background: true,
  status,
});
const user = (id: string): ChatEntry => ({ kind: "user", id, ts: "", text: id });

describe("staleTaskIds", () => {
  it("marks a running task from before the latest user turn once the agent is idle or responded", () => {
    const entries = [task("t1"), user("u1"), task("t2")];
    expect([...staleTaskIds(entries, "idle")]).toEqual(["t1"]);
    expect([...staleTaskIds(entries, "responded")]).toEqual(["t1"]);
  });

  it("never marks a shell task: the agent's status says nothing about it", () => {
    const shell: ChatTaskEntry = { ...task("s1"), taskKind: "shell" };
    expect([...staleTaskIds([shell, user("u1")], "idle")]).toEqual([]);
  });

  it("trusts every task while the agent is busy or its status is not known", () => {
    const entries = [task("t1"), user("u1")];
    for (const status of ["thinking", "working", "requires_input", "error", null] as const) {
      expect(staleTaskIds(entries, status).size).toBe(0);
    }
  });

  it("leaves finished tasks and tasks after the latest user turn alone", () => {
    expect(staleTaskIds([task("t1", "ok"), user("u1")], "idle").size).toBe(0);
    expect(staleTaskIds([user("u1"), task("t1")], "idle").size).toBe(0);
    expect(staleTaskIds([task("t1")], "idle").size).toBe(0);
  });

  it("groups tasks with the status they show", () => {
    const entries = [task("t1"), user("u1"), task("t2"), task("t3", "ok"), task("t4")];
    const shown = (items: ReturnType<typeof groupEntries>) =>
      chatTasks(items).map((t) => [t.id, t.display]);
    expect(shown(groupEntries(entries, "idle"))).toEqual([
      ["t1", "unknown"],
      ["t2", "running"],
      ["t3", "ok"],
      ["t4", "running"],
    ]);
    expect(shown(groupEntries(entries))).toEqual([
      ["t1", "running"],
      ["t2", "running"],
      ["t3", "ok"],
      ["t4", "running"],
    ]);
  });
});

describe("sameItem", () => {
  it("matches items regrouped from the same entries, and not once one changes", () => {
    const entries = [user("u1"), tool("a", "Read"), tool("b", "Bash"), task("t1")];
    const before = groupEntries(entries, "idle");
    const again = groupEntries(entries, "idle");
    expect(before.every((item, i) => sameItem(item, again[i]))).toBe(true);

    const changed = groupEntries([...entries.slice(0, 2), tool("b", "Bash", "error"), entries[3]], "idle");
    expect(before.map((item, i) => sameItem(item, changed[i]))).toEqual([true, false, true]);
    // The task's shown status is part of it.
    expect(sameItem(before[2], groupEntries(entries, "working")[2])).toBe(true);
    expect(sameItem(before[2], { ...before[2], display: "unknown" } as typeof before[2])).toBe(false);
  });
});

describe("task card text", () => {
  it("formats elapsed time", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(59.9)).toBe("59s");
    expect(formatElapsed(185)).toBe("3m 05s");
    expect(formatElapsed(3720)).toBe("1h 02m");
  });

  it("formats a finished duration", () => {
    expect(formatDuration(2)).toBe("1s");
    expect(formatDuration(2685)).toBe("3s");
    expect(formatDuration(59_000)).toBe("59s");
    expect(formatDuration(120_000)).toBe("2m");
    expect(formatDuration(134_000)).toBe("2m 14s");
    expect(formatDuration(3_725_000)).toBe("1h 2m");
  });

  it("previews the first non-empty line of a result", () => {
    expect(resultPreview(undefined)).toBeNull();
    expect(resultPreview("\n  \n")).toBeNull();
    expect(resultPreview("\n  Found it.\nMore")).toBe("Found it.");
  });
});

describe("splitPrompt", () => {
  it("leaves a prompt with no paste whole", () => {
    expect(splitPrompt("  fix it\n")).toEqual([{ kind: "typed", text: "  fix it\n" }]);
  });

  it("folds out a paste, whose closing tag may carry attributes", () => {
    const text =
      'look:\n\n<pasted_content id="db6d">\nline 1\nline 2\n</pasted_content id="db6d">\n\nany fix?';
    expect(splitPrompt(text)).toEqual([
      { kind: "typed", text: "look:" },
      { kind: "pasted", text: "line 1\nline 2" },
      { kind: "typed", text: "any fix?" },
    ]);
  });

  it("keeps several pastes, with nothing typed around them", () => {
    const text = "<pasted_content>a</pasted_content><pasted_content>b</pasted_content>";
    expect(splitPrompt(text)).toEqual([
      { kind: "pasted", text: "a" },
      { kind: "pasted", text: "b" },
    ]);
  });
});
