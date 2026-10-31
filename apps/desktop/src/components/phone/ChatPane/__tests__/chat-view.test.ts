/**
 * Which agents a phone offers the chat for. A Claude or Codex agent with a
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
  it("is null with no agent, an agent of a kind with no chat, or no transcript yet", () => {
    expect(chatTranscriptPath(null)).toBeNull();
    expect(chatTranscriptPath(agent({ agentKind: "aider" } as unknown as Partial<AgentInfo>))).toBeNull();
    expect(chatTranscriptPath(agent({ agentKind: "codex", transcriptPath: null } as Partial<AgentInfo>))).toBeNull();
    expect(chatTranscriptPath(agent({ transcriptPath: null }))).toBeNull();
    expect(chatTranscriptPath(agent({ transcriptPath: "" }))).toBeNull();
  });

  it("is the transcript for a local Claude agent", () => {
    expect(chatTranscriptPath(agent({}))).toBe("/tmp/t.jsonl");
  });

  it("is the rollout for a Codex agent", () => {
    const rollout = "/home/me/.codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-abc.jsonl";
    expect(chatTranscriptPath(agent({ agentKind: "codex", transcriptPath: rollout } as Partial<AgentInfo>))).toBe(
      rollout,
    );
  });

  it("is the transcript for a Claude agent on a remote host", () => {
    expect(
      chatTranscriptPath(agent({ hostId: "devbox", transcriptPath: "/home/me/.claude/t.jsonl" })),
    ).toBe("/home/me/.claude/t.jsonl");
  });
});
