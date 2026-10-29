import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentInfo } from "../../../electron.d";
import { useAgentStore } from "../../../store/agent-store";
import { useReviewStore, NO_DRAFTS, type DraftComment } from "../../../store/review-store";
import { submitReview, type ReviewTarget } from "../../../lib/review-submit";

/** How long "Discard 3 comments?" waits for its "Yes" before backing out. */
const CONFIRM_TIMEOUT = 4000;

export type ReviewSend = {
  /** The workspace's drafts, in creation order. */
  comments: DraftComment[];
  /** Live agents in the workspace that can take it, most recently updated first. */
  agents: AgentInfo[];
  /** Where the split button's body sends: the newest agent, else a new one. */
  defaultTarget: ReviewTarget;
  /** Send the drafts to `target`, then clear them. */
  send: (target: ReviewTarget) => void;
};

/**
 * A workspace's review in progress and where it can go. Batching is the whole
 * point: one interrupt per review rather than one per remark, so whatever
 * shows this sends all the drafts at once, and its default destination — the
 * most recently updated agent already running in the workspace — makes the
 * common case one click.
 */
export function useReviewSend(workspacePath: string, hostId?: string): ReviewSend {
  const comments = useReviewStore((s) => s.drafts[workspacePath] ?? NO_DRAFTS);
  const allAgents = useAgentStore((s) => s.agents);

  /**
   * Filtered here rather than inside the selector: a selector that builds a
   * new array on every store read would re-render on every unrelated agent
   * update.
   */
  const agents = useMemo(
    () =>
      allAgents
        .filter((a) => a.workspacePath === workspacePath && a.status === "active" && a.paneId)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [allAgents, workspacePath],
  );

  const send = useCallback(
    (target: ReviewTarget) => {
      submitReview(workspacePath, comments, target, hostId);
      useReviewStore.getState().clearWorkspace(workspacePath);
    },
    [workspacePath, hostId, comments],
  );

  const defaultTarget: ReviewTarget = agents[0]
    ? { kind: "agent", agent: agents[0] }
    : { kind: "new" };

  return { comments, agents, defaultTarget, send };
}

/**
 * Discard's two clicks: the first arms it ("Discard 3 comments?"), the second
 * throws the workspace's drafts away. Unanswered, it disarms itself.
 */
export function useDiscardConfirm(workspacePath: string) {
  const [confirming, setConfirming] = useState(false);

  /** A confirm that is never answered should go away, not sit there armed. */
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), CONFIRM_TIMEOUT);
    return () => clearTimeout(timer);
  }, [confirming]);

  const press = useCallback(() => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    useReviewStore.getState().clearWorkspace(workspacePath);
  }, [confirming, workspacePath]);

  return { confirming, press };
}

/** "1 comment" / "3 comments". */
export function countLabel(n: number): string {
  return n === 1 ? "1 comment" : `${n} comments`;
}

/** Just the filename: the lists are narrow, and the path is not the point. */
export function commentFile(comment: DraftComment): string {
  return comment.filePath.split("/").pop() ?? comment.filePath;
}

/**
 * Where a comment sits, as `name.ts:12` (or `:12–18` for a range). A comment
 * left in the Diff pane has no line of the file, only its diff label.
 */
export function commentWhere(comment: DraftComment): string {
  const file = commentFile(comment);
  if (comment.startLine === undefined) {
    return comment.startLabel ? `${file} ${comment.startLabel}` : file;
  }
  const end = comment.endLine ?? comment.startLine;
  return end > comment.startLine ? `${file}:${comment.startLine}–${end}` : `${file}:${comment.startLine}`;
}
