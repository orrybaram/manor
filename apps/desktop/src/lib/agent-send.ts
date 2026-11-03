import type { AgentInfo } from "../electron.d";
import { toast } from "../toast";
import { navigateToAgent } from "../utils/agent-navigation";
import { cleanAgentTitle } from "../utils/agent-title";
import { startAgentWithPrompt } from "./agent-prompt-launch";
import { flattenPrompt } from "./agent-command";
import { adapterForKind } from "./harness";

/** Where a batch of feedback goes: an agent already in the workspace, or a new one. */
export type AgentTarget =
  | { kind: "agent"; agent: AgentInfo }
  | { kind: "new" };

/** The name to call an agent in a menu row or a toast. */
export function agentLabel(agent: AgentInfo): string {
  return cleanAgentTitle(agent.name) ?? agent.agentKind;
}

/**
 * Deliver one prompt to `target` and say so: a diff review and a page's
 * notes both end here. `what` names the batch in the toast ("3 comments").
 *
 * The prompt is built multi-line by its caller; this is the one place that
 * flattens it, because only delivery cares that a bare newline in a
 * harness's prompt box submits the turn early. Returns whether it was sent:
 * an agent with no live pane can't take it.
 */
export function sendPromptToAgent(
  workspacePath: string,
  prompt: string,
  target: AgentTarget,
  { what, toastId, hostId }: { what: string; toastId: string; hostId?: string | null },
): boolean {
  if (target.kind === "new") {
    startAgentWithPrompt(workspacePath, prompt, hostId);
    toast.success(`Sent ${what} to a new agent`, { id: toastId, duration: 3000 });
    return true;
  }

  const { agent } = target;
  const { paneId } = agent;
  if (!paneId) {
    toast.error(`${agentLabel(agent)} has no live pane to send to`, {
      id: toastId,
      duration: 3000,
    });
    return false;
  }

  // Ordering is load-bearing, and mirrors `POST /sessions/send` in
  // electron/routes/agents.ts: interrupt to end the current turn, then submit
  // the new prompt. No artificial delay — the pty layer can't guarantee one.
  void window.electronAPI.pty.write(
    paneId,
    adapterForKind(agent.agentKind).interruptSequence(),
  );
  void window.electronAPI.pty.write(paneId, `${flattenPrompt(prompt)}\r`);

  // Land the user on the pane that is about to answer.
  navigateToAgent(agent);

  toast.success(`Sent ${what} to ${agentLabel(agent)}`, { id: toastId, duration: 3000 });
  return true;
}
