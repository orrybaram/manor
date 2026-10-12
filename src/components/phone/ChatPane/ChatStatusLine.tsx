import { useState } from "react";
import GitPullRequest from "lucide-react/dist/esm/icons/git-pull-request";
import GitPullRequestDraft from "lucide-react/dist/esm/icons/git-pull-request-draft";
import { useShallow } from "zustand/react/shallow";
import { find } from "../../../lib/workspace-directory";
import { selectActiveWorkspaceKey, useAppStore } from "../../../store/app-store";
import { useProjectStore } from "../../../store/project-store";
import { Button } from "../../ui/Button/Button";
import { Link } from "../../ui/Link/Link";
import { formatContextTokens, statusLineModel } from "./chat-status-line";
import { PhonePrSheet } from "./PhonePrSheet";
import styles from "./ChatPane.module.css";

/**
 * The line under the chat's input: the active workspace's open pull request
 * (number, opening a drawer), its CI (linking to GitHub), and the diff stat
 * (opening the diff pane) as chips, so "2 failing" is in view while you ask
 * Claude to fix it. The session's context size sits on the right. Renders
 * nothing when none of them has anything to show.
 *
 * Keyed off the active workspace: a phone only ever shows that one, and a
 * background workspace's chat is mounted but hidden.
 */
type ChatStatusLineProps = {
  /** The session's context size in tokens, or null if not known (ADR-223 D4). */
  contextTokens?: number | null;
};

export function ChatStatusLine(props: ChatStatusLineProps) {
  const { contextTokens } = props;
  const activeKey = useAppStore(selectActiveWorkspaceKey);
  // Shallow-compared: `find` builds a fresh object per store read, but the
  // fields picked from it are the store's own.
  const { workspace, hostId } = useProjectStore(
    useShallow((s) => {
      const found = activeKey ? find(s.projects, activeKey) : undefined;
      return { workspace: found?.workspace, hostId: found?.project.hostId };
    }),
  );
  const [prOpen, setPrOpen] = useState(false);
  const { pr, ci, diff } = statusLineModel({
    pr: workspace?.pr,
    diffStats: workspace?.diffStats,
  });
  const hasTokens = contextTokens != null;
  if (!pr && !ci && !diff && !hasTokens) return null;

  const draft = pr?.isDraft === true;
  const PrIcon = draft ? GitPullRequestDraft : GitPullRequest;

  return (
    <div className={styles.statusLine} data-testid="chat-status-line">
      {pr && (
        <>
          <Button
            variant="ghost"
            className={styles.statusChip}
            aria-label={`Pull request #${pr.number}: ${pr.title}`}
            onClick={() => setPrOpen(true)}
          >
            <PrIcon
              size={11}
              className={styles.statusPrIcon}
              data-draft={draft || undefined}
            />
            #{pr.number}
          </Button>
          <PhonePrSheet
            open={prOpen}
            onOpenChange={setPrOpen}
            pr={pr}
            workspacePath={workspace?.path}
            hostId={hostId}
          />
        </>
      )}
      {ci && (
        <Link
          variant="plain"
          href={ci.url}
          className={styles.statusChip}
          data-tone={ci.tone}
          aria-label={`Checks ${ci.tone}`}
        >
          <span className={styles.statusDot} />
          {ci.label}
        </Link>
      )}
      {diff && (
        <Button
          variant="ghost"
          className={styles.statusChip}
          aria-label={`${diff.additions} additions, ${diff.deletions} deletions`}
          onClick={() => useAppStore.getState().openOrFocusDiff()}
        >
          <span className={styles.statusAdditions}>+{diff.additions}</span>
          <span className={styles.statusDeletions}>−{diff.deletions}</span>
        </Button>
      )}
      <span className={styles.statusSpacer} />
      {hasTokens && (
        <span
          className={styles.statusTokens}
          title={`${contextTokens.toLocaleString()} tokens`}
          aria-label={`${contextTokens} tokens in context`}
        >
          {formatContextTokens(contextTokens)}
        </span>
      )}
    </div>
  );
}
