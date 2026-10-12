import GitPullRequest from "lucide-react/dist/esm/icons/git-pull-request";
import GitPullRequestDraft from "lucide-react/dist/esm/icons/git-pull-request-draft";
import { find } from "../../../lib/workspace-directory";
import { selectActiveWorkspaceKey, useAppStore } from "../../../store/app-store";
import { useProjectStore } from "../../../store/project-store";
import { Link } from "../../ui/Link/Link";
import { prStatusChips } from "./chat-status-line";
import styles from "./ChatPane.module.css";

/**
 * The line under the chat's input: the active workspace's open pull request
 * as chips — number, CI, diff stat — each linking to its page on GitHub, so
 * "2 failing" is in view while you ask Claude to fix it. Renders nothing
 * without an open PR.
 *
 * Keyed off the active workspace: a phone only ever shows that one, and a
 * background workspace's chat is mounted but hidden.
 */
export function ChatStatusLine() {
  const activeKey = useAppStore(selectActiveWorkspaceKey);
  const pr = useProjectStore((s) =>
    activeKey ? find(s.projects, activeKey)?.workspace.pr : null,
  );
  const chips = prStatusChips(pr);
  if (!chips) return null;

  const PrIcon = chips.draft ? GitPullRequestDraft : GitPullRequest;

  return (
    <div className={styles.statusLine} data-testid="chat-status-line">
      <Link
        variant="plain"
        href={chips.url}
        className={styles.statusChip}
        aria-label={`Pull request #${chips.number}: ${chips.title}`}
      >
        <PrIcon size={11} className={styles.statusPrIcon} data-draft={chips.draft || undefined} />
        #{chips.number}
      </Link>
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
        <Link
          variant="plain"
          href={chips.diff.url}
          className={styles.statusChip}
          aria-label={`${chips.diff.additions} additions, ${chips.diff.deletions} deletions`}
        >
          <span className={styles.statusAdditions}>+{chips.diff.additions}</span>
          <span className={styles.statusDeletions}>−{chips.diff.deletions}</span>
        </Link>
      )}
    </div>
  );
}
