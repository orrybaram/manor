import { DEFAULT_AGENT_COMMAND } from "./agent-command";
import { ownerOf, type DirectoryProject } from "./workspace-directory";
import type { WorkspaceKey } from "./workspace-key";

/** The slice of a project `resolveAgentCommand` reads. */
export interface AgentCommandProject extends DirectoryProject {
  agentCommand: string | null;
}

/**
 * The launch command for one workspace, most specific source first: an
 * explicit `override`, the owning project's `agentCommand` — the project on
 * the workspace's own host (ADR-191) — then the default. Home is the
 * Dashboard and has no agent (ADR-197), so its key owns nothing and gets the
 * default.
 *
 * Pure, and free of stores and managers, so both sides of the app ask the one
 * question the same way (ADR-182 D8): the renderer's `getAgentCommand`
 * (`src/agent-defaults.ts`) hands it Zustand state, and `POST /agents`
 * (`electron/routes/agents.ts`) hands it what the managers hold. It lives
 * outside `agent-defaults.ts` because that module reaches for the stores.
 */
export function resolveAgentCommand({
  override,
  key,
  projects,
}: {
  override?: string;
  key: WorkspaceKey | null;
  projects: readonly AgentCommandProject[];
}): string {
  if (override) return override;
  if (!key) return DEFAULT_AGENT_COMMAND;
  return ownerOf(projects, key)?.agentCommand ?? DEFAULT_AGENT_COMMAND;
}
