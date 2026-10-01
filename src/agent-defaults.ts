import { useProjectStore } from "./store/project-store";
import { ownerOf } from "./lib/workspace-directory";
import type { WorkspaceKey } from "./lib/workspace-key";

/**
 * Default agent command used when no project-specific command is configured.
 * Defined in the import-free `lib/agent-command` leaf so the main process can
 * read it too; re-exported here, which is where renderer code expects it.
 */
export { DEFAULT_AGENT_COMMAND } from "./lib/agent-command";
import { DEFAULT_AGENT_COMMAND } from "./lib/agent-command";

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
 * source first: `override` (an explicit caller-supplied command), the owning project's `agentCommand`, then the
 * global default.
 */
export function getAgentCommand(
  key: WorkspaceKey | null,
  override?: string,
): string {
  if (override) return override;
  if (!key) return DEFAULT_AGENT_COMMAND;
  const proj = ownerOf(useProjectStore.getState().projects, key);
  return proj?.agentCommand ?? DEFAULT_AGENT_COMMAND;
}
