import { useProjectStore } from "./store/project-store";

/** Default agent command used when no project-specific command is configured */
export const DEFAULT_AGENT_COMMAND = "claude --dangerously-skip-permissions";

/** Resolve the agent command for the given workspace path. */
export function getAgentCommand(workspacePath: string | null): string {
  if (!workspacePath) return DEFAULT_AGENT_COMMAND;
  const proj = useProjectStore.getState().projects.find((p) =>
    p.workspaces.some((w) => w.path === workspacePath),
  );
  return proj?.agentCommand ?? DEFAULT_AGENT_COMMAND;
}
