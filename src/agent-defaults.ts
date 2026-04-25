import { useProjectStore } from "./store/project-store";

/** Default agent command used when no project-specific command is configured */
export const DEFAULT_AGENT_COMMAND = "claude --dangerously-skip-permissions";

/** Known agent kinds — must mirror AgentKind in electron/terminal-host/types.ts */
const AGENT_KIND_TOKENS: Array<{ kind: string; tokens: string[] }> = [
  { kind: "codex", tokens: ["codex"] },
  { kind: "opencode", tokens: ["opencode"] },
  { kind: "pi", tokens: ["pi"] },
  { kind: "claude", tokens: ["claude"] },
];

/**
 * Derive the agent kind from a CLI command string.
 * Mirrors the logic in getConnectorForCommand() in electron/agent-connectors.ts.
 * Falls back to "claude" for unrecognised commands.
 */
export function getAgentKindForCommand(command: string): string {
  const firstToken = (command.split(" ")[0] ?? "").toLowerCase();
  for (const { kind, tokens } of AGENT_KIND_TOKENS) {
    if (tokens.some((t) => firstToken.includes(t))) {
      return kind;
    }
  }
  return "claude";
}

/** Resolve the agent command for the given workspace path. */
export function getAgentCommand(workspacePath: string | null): string {
  if (!workspacePath) return DEFAULT_AGENT_COMMAND;
  const proj = useProjectStore.getState().projects.find((p) =>
    p.workspaces.some((w) => w.path === workspacePath),
  );
  return proj?.agentCommand ?? DEFAULT_AGENT_COMMAND;
}
