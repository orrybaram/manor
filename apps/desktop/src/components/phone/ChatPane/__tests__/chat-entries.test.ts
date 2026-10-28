/**
 * Runs of tool calls fold into one group, summed up as a sentence.
 */
import { describe, expect, it } from "vitest";
import type { ChatEntry, ChatTaskEntry } from "../../../../electron.d";
import {
  formatElapsed,
  groupEntries,
  resultPreview,
  runningTaskCount,
  sameItem,
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

  it("groups tasks with the status they show, and counts the running ones", () => {
    const entries = [task("t1"), user("u1"), task("t2"), task("t3", "ok"), task("t4")];
    const idle = groupEntries(entries, "idle");
    expect(idle.flatMap((i) => (i.kind === "task" ? [[i.id, i.display]] : []))).toEqual([
      ["t1", "unknown"],
      ["t2", "running"],
      ["t3", "ok"],
      ["t4", "running"],
    ]);
    expect(runningTaskCount(idle)).toBe(2);
    expect(runningTaskCount(groupEntries(entries))).toBe(3);
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

  it("previews the first non-empty line of a result", () => {
    expect(resultPreview(undefined)).toBeNull();
    expect(resultPreview("\n  \n")).toBeNull();
    expect(resultPreview("\n  Found it.\nMore")).toBe("Found it.");
  });
});
