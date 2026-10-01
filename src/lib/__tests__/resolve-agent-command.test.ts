import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_COMMAND } from "../agent-command";
import { HOME_PATH } from "../home-path";
import { resolveAgentCommand } from "../resolve-agent-command";
import { workspaceKey, type WorkspaceKey } from "../workspace-key";

const PROJECTS = [
  {
    path: "/repos/ws",
    hostId: null,
    agentCommand: "claude --workspace",
    workspaces: [{ path: "/repos/ws" }],
  },
  {
    path: "/repos/plain",
    hostId: null,
    agentCommand: null,
    workspaces: [{ path: "/repos/plain" }],
  },
  {
    path: "/repos/ws",
    hostId: "box",
    agentCommand: "codex",
    workspaces: [{ path: "/repos/ws" }],
  },
];

function resolve(key: string | null, override?: string): string {
  return resolveAgentCommand({
    override,
    key: key as WorkspaceKey | null,
    projects: PROJECTS,
  });
}

describe("resolveAgentCommand", () => {
  it("prefers an explicit override over everything", () => {
    expect(resolve("/repos/ws", "my-agent")).toBe("my-agent");
    expect(resolve(HOME_PATH, "my-agent")).toBe("my-agent");
  });

  it("uses the owning project's command, on the key's own host", () => {
    expect(resolve("/repos/ws")).toBe("claude --workspace");
    expect(resolve(workspaceKey("box", "/repos/ws"))).toBe("codex");
  });

  it("falls back to the default for Home, a project without one, an unowned path, or none", () => {
    expect(resolve(HOME_PATH)).toBe(DEFAULT_AGENT_COMMAND);
    expect(resolve("/repos/plain")).toBe(DEFAULT_AGENT_COMMAND);
    expect(resolve("/repos/unknown")).toBe(DEFAULT_AGENT_COMMAND);
    expect(resolve(null)).toBe(DEFAULT_AGENT_COMMAND);
  });
});
