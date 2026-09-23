import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_COMMAND } from "../agent-command";
import { HOME_PATH } from "../home-path";
import { resolveAgentCommand } from "../resolve-agent-command";

const HOME_PREFS = {
  homeHarness: "custom" as const,
  homeCustomCommand: "my-harness --go",
  homeCustomInterrupt: "",
};

const PROJECTS = [
  { agentCommand: "claude --workspace", workspaces: [{ path: "/repos/ws" }] },
  { agentCommand: null, workspaces: [{ path: "/repos/plain" }] },
];

function resolve(
  workspacePath: string | null,
  override?: string,
): string {
  return resolveAgentCommand({
    override,
    workspacePath,
    homePrefs: HOME_PREFS,
    projects: PROJECTS,
  });
}

describe("resolveAgentCommand", () => {
  it("prefers an explicit override over everything", () => {
    expect(resolve("/repos/ws", "my-agent")).toBe("my-agent");
    expect(resolve(HOME_PATH, "my-agent")).toBe("my-agent");
  });

  it("uses the home harness for the Home surface", () => {
    expect(resolve(HOME_PATH)).toBe("my-harness --go");
  });

  it("uses the owning project's command", () => {
    expect(resolve("/repos/ws")).toBe("claude --workspace");
  });

  it("falls back to the default for a project without one, an unowned path, or none", () => {
    expect(resolve("/repos/plain")).toBe(DEFAULT_AGENT_COMMAND);
    expect(resolve("/repos/unknown")).toBe(DEFAULT_AGENT_COMMAND);
    expect(resolve(null)).toBe(DEFAULT_AGENT_COMMAND);
  });
});
