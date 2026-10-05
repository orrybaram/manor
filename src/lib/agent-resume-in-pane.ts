import type { AgentInfo, PaneAgentStatus } from "../electron.d";

/**
 * Whether a pane is known to have no agent running in it: the Status
 * reconciler published it with no Agent kind (a shell at its prompt). A pane
 * it has said nothing about yet is not known to be empty.
 */
export function paneHasNoAgent(status: PaneAgentStatus | undefined): boolean {
  return status !== undefined && status.kind === null;
}

/**
 * Resume `agent` in its own pane, by typing its resume command at the shell
 * there. For an Agent still recorded as active whose pane came back as a
 * bare shell — its terminal session was lost and the cold start did not
 * relaunch it — so clicking it brings the agent back rather than showing an
 * empty terminal.
 */
export async function resumeAgentInPane(agent: AgentInfo): Promise<boolean> {
  const paneId = agent.paneId;
  if (!paneId) return false;
  const command = await window.electronAPI.agents.buildResumeCommand(agent.id);
  if (!command) return false;
  void window.electronAPI.agents.markResumed(agent.id);
  window.electronAPI.pty.write(paneId, `${command}\r`);
  return true;
}
