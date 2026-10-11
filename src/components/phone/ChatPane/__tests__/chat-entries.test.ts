/**
 * Runs of tool calls fold into one group, summed up as a sentence.
 */
import { describe, expect, it } from "vitest";
import type { ChatEntry } from "../../../../electron.d";
import { groupEntries, summarizeTools } from "../chat-entries";

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
