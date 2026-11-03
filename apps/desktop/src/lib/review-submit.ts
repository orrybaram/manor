import type { DraftComment } from "../store/review-store";
import { sendPromptToAgent, type AgentTarget } from "./agent-send";
import { renderPrompt, type PromptOverrides } from "./prompts/catalog";

export { agentLabel } from "./agent-send";

export type ReviewTarget = AgentTarget;

function commentCount(n: number): string {
  return n === 1 ? "1 comment" : `${n} comments`;
}

/**
 * Turn a batch of drafts into one message for an agent: say what is being
 * asked, then the comments, each with enough context to act on without asking
 * where it lives.
 *
 * The preamble is deliberately not "address these comments". A comment on a
 * diff is as often a question ("what is this for?") as a request, and an
 * imperative framing sends an agent off editing code when it was only asked
 * to explain it. So the instruction is to read each comment on its own terms
 * and to touch code only where one actually asks for a change.
 *
 * Built multi-line for readability and testability; `sendPromptToAgent` is the one
 * place that flattens it, because only the delivery step cares that a bare
 * newline in a harness's prompt box submits the turn early.
 */
export function reviewPrompt(comments: DraftComment[], overrides?: PromptOverrides | null): string {
  const lines: string[] = [];

  comments.forEach((comment, i) => {
    lines.push(
      `[${i + 1}] ${comment.filePath} ${comment.startLabel} — ${comment.body.trim()}`,
    );
    if (comment.snippet.trim()) {
      lines.push(`    Code: ${comment.snippet.trim()}`);
    }
  });

  return renderPrompt(
    "diffComments",
    { count_comments: commentCount(comments.length), comments: lines.join("\n") },
    overrides,
  );
}

/**
 * Send a finished review to `target`. Clearing the drafts afterwards is the
 * caller's job — this module owns delivery, not the review's lifecycle.
 */
export function submitReview(
  workspacePath: string,
  comments: DraftComment[],
  target: ReviewTarget,
  /** The workspace's host. */
  hostId?: string | null,
): void {
  if (comments.length === 0) return;
  sendPromptToAgent(workspacePath, reviewPrompt(comments), target, {
    what: commentCount(comments.length),
    toastId: `review-submit-${workspacePath}`,
    hostId,
  });
}
