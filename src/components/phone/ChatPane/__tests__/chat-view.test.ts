/**
 * ADR-216 D4: which agents a phone offers the chat for. A Claude agent with a
 * transcript gets it wherever it runs, a remote host included.
 */
import { describe, expect, it } from "vitest";
import type { AgentInfo } from "../../../../electron.d";
import { chatTranscriptPath } from "../chat-view";

function agent(over: Partial<AgentInfo>): AgentInfo {
  return {
    id: "agent-1",
    paneId: "pane-1",
    status: "active",
    agentKind: "claude",
    hostId: "local",
    transcriptPath: "/tmp/t.jsonl",
    ...over,
  } as unknown as AgentInfo;
}

describe("chatTranscriptPath", () => {
  it("is null with no agent, a non-Claude agent, or no transcript yet", () => {
    expect(chatTranscriptPath(null)).toBeNull();
    expect(chatTranscriptPath(agent({ agentKind: "codex" } as Partial<AgentInfo>))).toBeNull();
    expect(chatTranscriptPath(agent({ transcriptPath: null }))).toBeNull();
    expect(chatTranscriptPath(agent({ transcriptPath: "" }))).toBeNull();
  });

  it("is the transcript for a local Claude agent", () => {
    expect(chatTranscriptPath(agent({}))).toBe("/tmp/t.jsonl");
  });

  it("is the transcript for a Claude agent on a remote host", () => {
    expect(
      chatTranscriptPath(agent({ hostId: "devbox", transcriptPath: "/home/me/.claude/t.jsonl" })),
    ).toBe("/home/me/.claude/t.jsonl");
  });
});
