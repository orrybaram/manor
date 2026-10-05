/**
 * `agents.buildResumeCommand`: the command that resumes an Agent's session,
 * including one started by typing the CLI by hand, which recorded no command.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../notifications", () => ({
  updateDockBadge: vi.fn(),
  markAgentNotificationsRead: vi.fn(),
  sendAgentUpdate: vi.fn(),
  getUnseenSnapshot: vi.fn(() => ({ responded: [], requires_input: [] })),
}));

import { agentsBuildResumeCommand } from "../bridge/handlers/agents";
import { localCtx } from "../bridge/method";
import type { HostDeps } from "../routes/types";

function ctx(agent: Record<string, unknown>, projects: unknown[] = []) {
  const deps = {
    agentManager: { getAgentById: (id: string) => (id === agent.id ? agent : null) },
    projectManager: { getProjects: vi.fn().mockResolvedValue(projects) },
  };
  return localCtx(deps as unknown as HostDeps);
}

const base = {
  id: "a1",
  agentSessionId: "sess-1",
  agentKind: "claude",
  hostId: "local",
  workspacePath: "/repo/wt",
};

const project = (agentCommand: string | null) => ({
  id: "p1",
  hostId: "local",
  path: "/repo",
  agentCommand,
  workspaces: [{ path: "/repo/wt" }],
});

describe("agents.buildResumeCommand", () => {
  it("resumes from the command the Agent was launched with", async () => {
    const command = await agentsBuildResumeCommand(ctx({ ...base, agentCommand: "claude --model opus" }), "a1");
    expect(command).toBe("claude --model opus --resume sess-1");
  });

  it("falls back to the project's command for an Agent started by hand", async () => {
    const command = await agentsBuildResumeCommand(
      ctx({ ...base, agentCommand: null }, [project("claude --model sonnet")]),
      "a1",
    );
    expect(command).toBe("claude --model sonnet --resume sess-1");
  });

  it("uses the kind's default when the project runs a different kind of agent", async () => {
    const command = await agentsBuildResumeCommand(
      ctx({ ...base, agentCommand: null }, [project("codex --yolo")]),
      "a1",
    );
    expect(command).toMatch(/^claude .*--resume sess-1$/);
  });

  it("returns null for an unknown Agent", async () => {
    expect(await agentsBuildResumeCommand(ctx(base), "nope")).toBeNull();
  });
});
