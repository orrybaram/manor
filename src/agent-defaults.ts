import { useProjectStore } from "./store/project-store";
import type { WorkspaceKey } from "./lib/workspace-key";
import { resolveAgentCommand } from "./lib/resolve-agent-command";

/**
 * Default agent command used when no project-specific command is configured.
 * Defined in the import-free `lib/agent-command` leaf so the main process can
 * read it too; re-exported here, which is where renderer code expects it.
 */
export { DEFAULT_AGENT_COMMAND } from "./lib/agent-command";

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

/**
 * Resolve the agent command for the given workspace key, most specific
 * source first: `override` (an explicit caller-supplied command), the owning
 * project's `agentCommand`, then the global default. The precedence is
 * `resolveAgentCommand`'s, which the main process's `POST /agents` shares;
 * this reads its inputs out of the stores.
 */
export function getAgentCommand(
  key: WorkspaceKey | null,
  override?: string,
): string {
  return resolveAgentCommand({
    override,
    key,
    projects: useProjectStore.getState().projects,
  });
}
