import React, { useRef, useCallback, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Button } from "../ui/Button/Button";
import GitPullRequest from "lucide-react/dist/esm/icons/git-pull-request";
import GitMerge from "lucide-react/dist/esm/icons/git-merge";
import GitPullRequestClosed from "lucide-react/dist/esm/icons/git-pull-request-closed";
import CircleCheck from "lucide-react/dist/esm/icons/circle-check";
import CircleX from "lucide-react/dist/esm/icons/circle-x";
import CircleDot from "lucide-react/dist/esm/icons/circle-dot";
import Clock from "lucide-react/dist/esm/icons/clock";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert";
import ShieldQuestion from "lucide-react/dist/esm/icons/shield-question";
import MessageSquare from "lucide-react/dist/esm/icons/message-square";
import type { PrCheckRun, PrComment, PrInfo } from "../../store/project-store";
import { prReadiness } from "../../lib/pr-readiness";
import { fetchPrs } from "../../hooks/usePrWatcher";
import { relativeShortThenDate } from "../../utils/relative-time";
import styles from "./PrPopover.module.css";

type PrPopoverProps = {
  pr: PrInfo;
  onOpen: () => void;
};

const HOVER_DELAY = 300;

/**
 * Passing checks are listed too, but only after the ones that need attention —
 * and only enough of them to show the run names, since "which checks are
 * failing" is the question the list exists to answer.
 */
const MAX_PASSING_SHOWN = 4;

/** Comments are the tallest rows; past this the popover stops being a popover. */
const MAX_COMMENTS_SHOWN = 6;

function openExternal(url: string) {
  window.electronAPI.shell.openExternal(url);
}

/**
 * The hover card behind the PR badge. Everything in it is a link into GitHub —
 * a check row opens that run's logs, a comment row opens that comment — which
 * is why there is no "Open in GitHub" footer: clicking the badge itself
 * already does that.
 */
export function PrPopover(props: PrPopoverProps) {
  const { pr, onOpen } = props;

  const [open, setOpen] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHoverTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const handleMouseEnter = useCallback(() => {
    clearHoverTimeout();
    timeoutRef.current = setTimeout(() => {
      setOpen(true);
      fetchPrs();
    }, HOVER_DELAY);
  }, [clearHoverTimeout]);

  const handleMouseLeave = useCallback(() => {
    clearHoverTimeout();
    timeoutRef.current = setTimeout(() => setOpen(false), 150);
  }, [clearHoverTimeout]);

  const PrIcon =
    pr.state === "merged"
      ? GitMerge
      : pr.state === "closed"
        ? GitPullRequestClosed
        : GitPullRequest;

  const stateLabel =
    pr.state === "merged"
      ? "Merged"
      : pr.state === "closed"
        ? "Closed"
        : "Open";

  const stateClass =
    pr.state === "merged"
      ? styles.prPopoverStateMerged
      : pr.state === "closed"
        ? styles.prPopoverStateClosed
        : styles.prPopoverStateOpen;

  const readiness = prReadiness(pr);
  const badgeClass = {
    ready: styles.prReady,
    blocked: styles.prBlocked,
    pending: styles.prPending,
    merged: styles.prMerged,
    closed: styles.prClosed,
  }[readiness];

  const showDraftOutline =
    pr.isDraft && readiness !== "merged" && readiness !== "closed";

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <span
          className={`${styles.prBadge} ${badgeClass}${showDraftOutline ? ` ${styles.prDraft}` : ""}`}
          data-readiness={readiness}
          data-draft={pr.isDraft ? "true" : "false"}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          <PrIcon size={10} />#{pr.number}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={styles.prPopover}
          side="right"
          sideOffset={8}
          align="start"
          collisionPadding={8}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <div className={styles.prPopoverHeader}>
            <PrIcon size={14} />
            <span>#{pr.number}</span>
            <span className={stateClass}>{stateLabel}</span>
            {pr.isDraft && <span className={styles.prPopoverDraft}>Draft</span>}
            {pr.additions != null && pr.deletions != null && (
              <span className={styles.prPopoverDiffStat}>
                <span className={styles.prPopoverAdditions}>
                  +{pr.additions}
                </span>
                <span className={styles.prPopoverDeletions}>
                  −{pr.deletions}
                </span>
              </span>
            )}
          </div>

          <Button
            variant="ghost"
            size="sm"
            className={styles.prPopoverTitle}
            title="Open this pull request on GitHub"
            onClick={(e) => {
              e.stopPropagation();
              openExternal(pr.url);
            }}
          >
            {pr.title}
          </Button>

          <SummaryRows pr={pr} />

          <div className={styles.prPopoverScroll}>
            <ChecksSection pr={pr} />
            <CommentsSection pr={pr} />
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The one-line verdicts: CI, review, unresolved threads. */
function SummaryRows(props: { pr: PrInfo }) {
  const { pr } = props;

  let checksElement: React.ReactNode = null;
  if (pr.checks) {
    const { total, passing, failing, pending } = pr.checks;
    let checksText: string;
    let toneClass: string;
    let ChecksIcon: typeof CircleCheck;

    if (failing > 0) {
      checksText = `${failing} failing, ${passing} passing`;
      toneClass = styles.toneBad;
      ChecksIcon = CircleX;
    } else if (pending > 0) {
      checksText = `${pending} pending, ${passing} passing`;
      toneClass = styles.toneWarn;
      ChecksIcon = Clock;
    } else {
      checksText = `${passing}/${total} passing`;
      toneClass = styles.toneGood;
      ChecksIcon = CircleCheck;
    }

    checksElement = (
      <div className={`${styles.prPopoverRow} ${toneClass}`}>
        <ChecksIcon size={12} />
        <span>{checksText}</span>
      </div>
    );
  }

  let reviewElement: React.ReactNode = null;
  if (pr.reviewDecision) {
    let reviewText: string;
    let toneClass: string;
    let ReviewIcon: typeof ShieldCheck;

    switch (pr.reviewDecision) {
      case "APPROVED":
        reviewText = "Approved";
        toneClass = styles.toneGood;
        ReviewIcon = ShieldCheck;
        break;
      case "CHANGES_REQUESTED":
        reviewText = "Changes requested";
        toneClass = styles.toneWarn;
        ReviewIcon = ShieldAlert;
        break;
      default:
        reviewText = "Review required";
        toneClass = styles.toneWarn;
        ReviewIcon = ShieldQuestion;
        break;
    }

    reviewElement = (
      <div className={`${styles.prPopoverRow} ${toneClass}`}>
        <ReviewIcon size={12} />
        <span>{reviewText}</span>
      </div>
    );
  }

  let commentsElement: React.ReactNode = null;
  if (pr.unresolvedThreads != null && pr.unresolvedThreads > 0) {
    commentsElement = (
      <div className={`${styles.prPopoverRow} ${styles.toneWarn}`}>
        <MessageSquare size={12} />
        <span>{pr.unresolvedThreads} unresolved</span>
      </div>
    );
  }

  if (!checksElement && !reviewElement && !commentsElement) return null;

  return (
    <div className={styles.prPopoverSummary}>
      {checksElement}
      {reviewElement}
      {commentsElement}
    </div>
  );
}

/**
 * The named checks, failing first. Passing runs are trimmed to a handful and
 * then summarised — nobody hovers a badge to read the names of green jobs.
 */
function ChecksSection(props: { pr: PrInfo }) {
  const runs = props.pr.checkRuns;
  if (!runs || runs.length === 0) return null;

  const attention = runs.filter((r) => r.status !== "passing");
  const passing = runs.filter((r) => r.status === "passing");
  const shownPassing = passing.slice(0, MAX_PASSING_SHOWN);
  const hiddenPassing = passing.length - shownPassing.length;

  return (
    <section className={styles.prPopoverSection}>
      <div className={styles.prPopoverSectionLabel}>Checks</div>
      {[...attention, ...shownPassing].map((run, i) => (
        <CheckRow key={`${run.name}-${i}`} run={run} />
      ))}
      {hiddenPassing > 0 && (
        <div className={styles.prPopoverMore}>
          +{hiddenPassing} more passing
        </div>
      )}
    </section>
  );
}

function CheckRow(props: { run: PrCheckRun }) {
  const { run } = props;
  const Icon =
    run.status === "failing"
      ? CircleX
      : run.status === "pending"
        ? CircleDot
        : CircleCheck;
  const toneClass =
    run.status === "failing"
      ? styles.toneBad
      : run.status === "pending"
        ? styles.toneWarn
        : styles.toneGood;

  return (
    <Button
      variant="ghost"
      size="sm"
      className={styles.prPopoverCheck}
      disabled={!run.url}
      title={run.url ? `Open ${run.name} on GitHub` : run.name}
      onClick={(e) => {
        e.stopPropagation();
        if (run.url) openExternal(run.url);
      }}
    >
      <Icon size={11} className={toneClass} />
      <span className={styles.prPopoverCheckName}>{run.name}</span>
      {run.workflow && run.workflow !== run.name && (
        <span className={styles.prPopoverCheckWorkflow}>{run.workflow}</span>
      )}
    </Button>
  );
}

/** Who said what, newest first, across comments, reviews and inline threads. */
function CommentsSection(props: { pr: PrInfo }) {
  const comments = props.pr.recentComments;
  if (!comments || comments.length === 0) return null;

  const shown = comments.slice(0, MAX_COMMENTS_SHOWN);
  const hidden = comments.length - shown.length;

  return (
    <section className={styles.prPopoverSection}>
      <div className={styles.prPopoverSectionLabel}>Comments</div>
      {shown.map((comment) => (
        <CommentRow key={comment.url} comment={comment} />
      ))}
      {hidden > 0 && (
        <div className={styles.prPopoverMore}>+{hidden} more</div>
      )}
    </section>
  );
}

function CommentRow(props: { comment: PrComment }) {
  const { comment } = props;
  const body = comment.body.trim();

  return (
    <Button
      variant="ghost"
      size="sm"
      className={styles.prPopoverComment}
      title="Open this comment on GitHub"
      onClick={(e) => {
        e.stopPropagation();
        openExternal(comment.url);
      }}
    >
      <div className={styles.prPopoverCommentHead}>
        <span className={styles.prPopoverCommentAuthor}>
          {comment.author ? `@${comment.author}` : "unknown"}
        </span>
        <CommentTag comment={comment} />
        <span className={styles.prPopoverCommentTime}>
          {relativeShortThenDate(Date.parse(comment.createdAt))}
        </span>
      </div>
      {body ? (
        <div className={styles.prPopoverCommentBody}>{body}</div>
      ) : (
        <div className={styles.prPopoverCommentEmpty}>No comment text.</div>
      )}
    </Button>
  );
}

/** What kind of remark this is: a verdict, a file, or nothing worth saying. */
function CommentTag(props: { comment: PrComment }) {
  const { comment } = props;

  if (comment.kind === "review") {
    if (comment.reviewState === "APPROVED") {
      return (
        <span className={`${styles.prPopoverTag} ${styles.toneGood}`}>
          approved
        </span>
      );
    }
    if (comment.reviewState === "CHANGES_REQUESTED") {
      return (
        <span className={`${styles.prPopoverTag} ${styles.toneWarn}`}>
          changes requested
        </span>
      );
    }
    return <span className={styles.prPopoverTag}>review</span>;
  }

  if (comment.kind === "thread") {
    const file = comment.path?.split("/").pop();
    return (
      <span
        className={`${styles.prPopoverTag}${comment.isResolved ? "" : ` ${styles.toneWarn}`}`}
        title={comment.path ?? undefined}
      >
        {file ?? "inline"}
        {comment.isResolved ? "" : " · unresolved"}
      </span>
    );
  }

  return null;
}
