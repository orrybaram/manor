import { useState } from "react";
import GitPullRequest from "lucide-react/dist/esm/icons/git-pull-request";
import GitPullRequestDraft from "lucide-react/dist/esm/icons/git-pull-request-draft";
import { find } from "../../../lib/workspace-directory";
import { selectActiveWorkspaceKey, useAppStore } from "../../../store/app-store";
import { useProjectStore } from "../../../store/project-store";
import { Button } from "../../ui/Button/Button";
import { Link } from "../../ui/Link/Link";
import { formatContextTokens, prStatusChips } from "./chat-status-line";
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
  // Two selectors, not one returning `find`'s fresh object: a new object per
  // store read would re-render forever.
  const workspace = useProjectStore((s) =>
    activeKey ? find(s.projects, activeKey)?.workspace : undefined,
  );
  const hostId = useProjectStore((s) =>
    activeKey ? find(s.projects, activeKey)?.project.hostId : undefined,
  );
  const pr = workspace?.pr;
  const [prOpen, setPrOpen] = useState(false);
  const chips = prStatusChips({ pr, diffStats: workspace?.diffStats });
  const hasTokens = contextTokens != null;
  if (!chips.pr && !chips.ci && !chips.diff && !hasTokens) return null;

  const PrIcon = chips.pr?.draft ? GitPullRequestDraft : GitPullRequest;

  return (
    <div className={styles.statusLine} data-testid="chat-status-line">
      {chips.pr && pr && (
        <>
          <Button
            variant="ghost"
            className={styles.statusChip}
            aria-label={`Pull request #${chips.pr.number}: ${chips.pr.title}`}
            onClick={() => setPrOpen(true)}
          >
            <PrIcon
              size={11}
              className={styles.statusPrIcon}
              data-draft={chips.pr.draft || undefined}
            />
            #{chips.pr.number}
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
      {chips.ci && (
        <Link
          variant="plain"
          href={chips.ci.url}
          className={styles.statusChip}
          data-tone={chips.ci.tone}
          aria-label={`Checks ${chips.ci.tone}`}
        >
          <span className={styles.statusDot} />
          {chips.ci.label}
        </Link>
      )}
      {chips.diff && (
        <Button
          variant="ghost"
          className={styles.statusChip}
          aria-label={`${chips.diff.additions} additions, ${chips.diff.deletions} deletions`}
          onClick={() => useAppStore.getState().openOrFocusDiff()}
        >
          <span className={styles.statusAdditions}>+{chips.diff.additions}</span>
          <span className={styles.statusDeletions}>−{chips.diff.deletions}</span>
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
