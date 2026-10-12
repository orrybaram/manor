import { describe, expect, it } from "vitest";
import type { ChatTaskEntry } from "../../transcript";
import { claudeAdapter } from "../claude";

const T = "2026-01-01T00:00:00.000Z";

function task(over: Partial<ChatTaskEntry> = {}): ChatTaskEntry {
  return {
    kind: "task",
    id: "toolu_1",
    ts: T,
    taskKind: "agent",
    title: "Explore",
    background: true,
    status: "running",
    taskRef: "a688a22b79dd2f9a7",
    hasTranscript: true,
    ...over,
  };
}

describe("claudeAdapter.childTranscriptPath (ADR-224 D3)", () => {
  const parent = "/Users/me/.claude/projects/-Users-me-repo/edbdd1c8-662e.jsonl";

  it("resolves an agent task to <session>/subagents/agent-<agentId>.jsonl", () => {
    expect(claudeAdapter.childTranscriptPath(parent, task())).toBe(
      "/Users/me/.claude/projects/-Users-me-repo/edbdd1c8-662e/subagents/agent-a688a22b79dd2f9a7.jsonl",
    );
  });

  it("has no path for a task without an agentId, or one that is not an agent", () => {
    expect(claudeAdapter.childTranscriptPath(parent, task({ taskRef: undefined }))).toBeNull();
    expect(claudeAdapter.childTranscriptPath(parent, task({ taskKind: "shell" }))).toBeNull();
    expect(claudeAdapter.childTranscriptPath(parent, task({ taskKind: "other" }))).toBeNull();
  });

  it("refuses an agentId that would step out of the subagents directory", () => {
    expect(claudeAdapter.childTranscriptPath(parent, task({ taskRef: "../../etc" }))).toBeNull();
  });
});

describe("claudeAdapter.createParser", () => {
  const sidechain = (uuid: string, text: string) =>
    JSON.stringify({
      type: "user",
      uuid,
      timestamp: T,
      isSidechain: true,
      message: { role: "user", content: text },
    });

  it("drops sidechain lines from the pane's transcript", () => {
    expect(claudeAdapter.createParser().push(sidechain("u1", "hi"))).toEqual([]);
  });

  it("keeps them in a child's", () => {
    expect(claudeAdapter.createParser({ child: true }).push(sidechain("u1", "hi"))).toEqual([
      { kind: "user", id: "u1", ts: T, text: "hi" },
    ]);
  });
});
