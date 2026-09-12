import type { AgentInfo } from "../electron.d";
import type { DraftComment } from "../store/review-store";
import { useToastStore } from "../store/toast-store";
import { navigateToAgent } from "../utils/agent-navigation";
import { cleanAgentTitle } from "../utils/agent-title";
import { flattenPrompt, startAgentWithPrompt } from "./agent-prompt-launch";
import { adapterForKind } from "./harness";

export type ReviewTarget =
  | { kind: "agent"; agent: AgentInfo }
  | { kind: "new" };

/**
 * A draft is created empty — the composer *is* the creation step — so a
 * comment that never got a body is not a comment. Filtering here as well as
 * in the bar keeps a blank draft out of the prompt no matter who calls.
 */
function written(comments: DraftComment[]): DraftComment[] {
  return comments.filter((c) => c.body.trim() !== "");
}

/** The name to call an agent in a menu row or a toast. */
export function agentLabel(agent: AgentInfo): string {
  return cleanAgentTitle(agent.name) ?? agent.agentKind;
}

function commentCount(n: number): string {
  return n === 1 ? "1 comment" : `${n} comments`;
}

/**
 * Turn a batch of drafts into one message for an agent, in the register
 * `reviewCommentPrompt` (PrPopover) already established: say what is being
 * asked, then the comments, each with enough context to act on without
 * asking where it lives.
 *
 * Built multi-line for readability and testability; `submitReview` is the one
 * place that flattens it, because only the delivery step cares that a bare
 * newline in a harness's prompt box submits the turn early.
 */
export function reviewPrompt(comments: DraftComment[]): string {
  const real = written(comments);
  const lines: string[] = [
    real.length === 1
      ? "Address this review comment on the current diff:"
      : `Address these ${real.length} review comments on the current diff:`,
  ];

  real.forEach((comment, i) => {
    lines.push(
      `[${i + 1}] ${comment.filePath} ${comment.startLabel} — ${comment.body.trim()}`,
    );
    if (comment.snippet.trim()) {
      lines.push(`    Code: ${comment.snippet.trim()}`);
    }
  });

  return lines.join("\n");
}

/**
 * Send a finished review to `target`. Clearing the drafts afterwards is the
 * caller's job — this module owns delivery, not the review's lifecycle.
 */
export function submitReview(
  workspacePath: string,
  comments: DraftComment[],
  target: ReviewTarget,
): void {
  const real = written(comments);
  if (real.length === 0) return;

  const prompt = reviewPrompt(real);
  const { addToast } = useToastStore.getState();
  const toastId = `review-submit-${workspacePath}`;

  if (target.kind === "new") {
    startAgentWithPrompt(workspacePath, prompt);
    addToast({
      id: toastId,
      message: `Sent ${commentCount(real.length)} to a new agent`,
      status: "success",
      duration: 3000,
    });
    return;
  }

  const { agent } = target;
  const { paneId } = agent;
  if (!paneId) {
    addToast({
      id: toastId,
      message: `${agentLabel(agent)} has no live pane to send to`,
      status: "error",
      duration: 3000,
    });
    return;
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

  addToast({
    id: toastId,
    message: `Sent ${commentCount(real.length)} to ${agentLabel(agent)}`,
    status: "success",
    duration: 3000,
  });
}
