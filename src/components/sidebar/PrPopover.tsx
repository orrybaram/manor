import React, { useRef, useCallback, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Button } from "../ui/Button/Button";
import GitPullRequest from "lucide-react/dist/esm/icons/git-pull-request";
import GitMerge from "lucide-react/dist/esm/icons/git-merge";
import GitPullRequestClosed from "lucide-react/dist/esm/icons/git-pull-request-closed";
import CircleCheck from "lucide-react/dist/esm/icons/circle-check";
import CircleX from "lucide-react/dist/esm/icons/circle-x";
import CircleDot from "lucide-react/dist/esm/icons/circle-dot";
import CircleMinus from "lucide-react/dist/esm/icons/circle-minus";
import Clock from "lucide-react/dist/esm/icons/clock";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert";
import ShieldQuestion from "lucide-react/dist/esm/icons/shield-question";
import MessageSquare from "lucide-react/dist/esm/icons/message-square";
import GitPullRequestDraft from "lucide-react/dist/esm/icons/git-pull-request-draft";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle";
import type { PrCheckRun, PrComment, PrInfo } from "../../store/project-store";
import { prReadiness, type PrReadiness } from "../../lib/pr-readiness";
import { startAgentWithPrompt } from "../../lib/agent-prompt-launch";
import { fetchPrs } from "../../hooks/usePrWatcher";
import { PrCommentCard } from "../ui/PrCommentCard/PrCommentCard";
import styles from "./PrPopover.module.css";

type PrPopoverProps = {
  pr: PrInfo;
  onOpen: () => void;
  /**
   * The workspace this PR belongs to. When given, an unresolved review
   * thread offers "Send to agent", which starts an agent there with the
   * comment as its prompt.
   */
  workspacePath?: string;
};

const HOVER_DELAY = 300;

/**
 * Checks are ordered failing → pending → passing → skipped by the fetcher, so
 * collapsing to the first few keeps every check that needs attention visible
 * and hides only the green (and grey) tail.
 */
const MAX_CHECKS_COLLAPSED = 10;

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
  const { pr, onOpen, workspacePath } = props;

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
    queued: styles.prQueued,
    pending: styles.prPending,
    merged: styles.prMerged,
    closed: styles.prClosed,
  }[readiness];

  const isLive = readiness !== "merged" && readiness !== "closed";

  const { Icon: BadgeIcon, spin, tone } = badgeIcon(pr, readiness);

  const showDraftOutline = pr.isDraft && isLive;

  const handleSendToAgent = useCallback(
    (comment: PrComment) => {
      if (!workspacePath) return;
      clearHoverTimeout();
      setOpen(false);
      startAgentWithPrompt(workspacePath, reviewCommentPrompt(pr, comment));
    },
    [workspacePath, pr, clearHoverTimeout],
  );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <span
          className={`${styles.prBadge} ${badgeClass}${tone ? ` ${tone}` : ""}${showDraftOutline ? ` ${styles.prDraft}` : ""}`}
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
          <BadgeIcon
            size={10}
            className={`${styles.prBadgeIcon}${spin ? ` ${styles.prBadgeSpin}` : ""}`}
          />
          #{pr.number}
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
          // The portal still bubbles React events to the workspace row: its
          // drag handler captures the pointer and eats every click in here,
          // a click would select the workspace, a double-click would rename it.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
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
            <CommentsSection
              pr={pr}
              onSendToAgent={workspacePath ? handleSendToAgent : undefined}
            />
            <ChecksSection pr={pr} />
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * ADR-167 keeps the badge on one question — "can this ship?" — which the
 * background answers in colour. The icon answers the follow-up: *what is it
 * waiting on?* It spins whenever the honest answer is "wait for a machine"
 * — a merge queue, or a CI run still going — and otherwise names the
 * blocker: a failing check, a reviewer, an unresolved thread.
 */
function badgeIcon(
  pr: PrInfo,
  readiness: PrReadiness,
): { Icon: typeof GitPullRequest; spin: boolean; tone?: string } {
  switch (readiness) {
    case "merged":
      return { Icon: GitMerge, spin: false };
    case "closed":
      return { Icon: GitPullRequestClosed, spin: false };
    // Auto-merge armed or sitting in the merge queue: it merges itself, so
    // the spin is the whole status — CI underneath it is nobody's problem.
    case "queued":
      return { Icon: LoaderCircle, spin: true };
    // Mirrors the order `prReadiness` blocks on, so the icon names the same
    // reason the badge turned yellow.
    case "blocked":
      if (pr.checks && pr.checks.failing > 0) {
        return { Icon: CircleX, spin: false, tone: styles.prIconBad };
      }
      if (pr.reviewDecision === "CHANGES_REQUESTED") {
        return { Icon: ShieldAlert, spin: false, tone: styles.prIconWarn };
      }
      return { Icon: MessageSquare, spin: false, tone: styles.prIconWarn };
    case "ready":
      return { Icon: CircleCheck, spin: false, tone: styles.prIconGood };
    default:
      if (pr.checks && pr.checks.pending > 0) {
        return { Icon: LoaderCircle, spin: true, tone: styles.prIconWarn };
      }
      return {
        Icon: pr.isDraft ? GitPullRequestDraft : GitPullRequest,
        spin: false,
      };
  }
}

/** The one-line verdicts: CI, review, unresolved threads. */
function SummaryRows(props: { pr: PrInfo }) {
  const { pr } = props;

  let checksElement: React.ReactNode = null;
  if (pr.checks) {
    const { total, passing, failing, pending } = pr.checks;
    const skipped = pr.checks.skipped ?? 0;
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
      checksText = `${passing}/${total - skipped} passing`;
      toneClass = styles.toneGood;
      ChecksIcon = CircleCheck;
    }
    if (skipped > 0) checksText += `, ${skipped} skipped`;

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

  let queuedElement: React.ReactNode = null;
  if (pr.queuedToMerge && pr.state === "open") {
    queuedElement = (
      <div className={`${styles.prPopoverRow} ${styles.toneQueued}`}>
        <GitMerge size={12} />
        <span>Queued to merge</span>
      </div>
    );
  }

  if (!checksElement && !reviewElement && !commentsElement && !queuedElement)
    return null;

  return (
    <div className={styles.prPopoverSummary}>
      {queuedElement}
      {checksElement}
      {reviewElement}
      {commentsElement}
    </div>
  );
}

/**
 * The named checks, failing first. Collapsed to the first few — which, given
 * the fetcher's ordering, is every check that needs attention plus as many
 * green ones as fit — with a row to unfold the rest.
 */
function ChecksSection(props: { pr: PrInfo }) {
  const runs = props.pr.checkRuns;
  const [expanded, setExpanded] = useState(false);
  if (!runs || runs.length === 0) return null;

  const shown = expanded ? runs : runs.slice(0, MAX_CHECKS_COLLAPSED);
  const hidden = runs.length - MAX_CHECKS_COLLAPSED;

  return (
    <section className={styles.prPopoverSection}>
      <div className={styles.prPopoverSectionLabel}>Checks</div>
      {shown.map((run, i) => (
        <CheckRow key={`${run.name}-${i}`} run={run} />
      ))}
      {hidden > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className={styles.prPopoverMore}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          {expanded ? "Show fewer" : `+${hidden} more`}
        </Button>
      )}
    </section>
  );
}

const CHECK_ICON: Record<PrCheckRun["status"], typeof CircleCheck> = {
  failing: CircleX,
  pending: CircleDot,
  passing: CircleCheck,
  skipped: CircleMinus,
};

function CheckRow(props: { run: PrCheckRun }) {
  const { run } = props;
  const Icon = CHECK_ICON[run.status];
  const toneClass = {
    failing: styles.toneBad,
    pending: styles.toneWarn,
    passing: styles.toneGood,
    skipped: styles.toneMuted,
  }[run.status];

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
      <span
        className={`${styles.prPopoverCheckName}${run.status === "skipped" ? ` ${styles.toneMuted}` : ""}`}
      >
        {run.name}
      </span>
      <span className={styles.prPopoverCheckWorkflow}>
        {run.status === "skipped"
          ? "skipped"
          : run.workflow && run.workflow !== run.name
            ? run.workflow
            : null}
      </span>
    </Button>
  );
}

/** Who said what, newest first, across comments, reviews and inline threads. */
function CommentsSection(props: {
  pr: PrInfo;
  onSendToAgent?: (comment: PrComment) => void;
}) {
  const comments = props.pr.recentComments;
  const [expanded, setExpanded] = useState(false);
  if (!comments || comments.length === 0) return null;

  const shown = expanded ? comments : comments.slice(0, MAX_COMMENTS_SHOWN);
  const hidden = comments.length - MAX_COMMENTS_SHOWN;

  return (
    <section
      className={`${styles.prPopoverSection} ${styles.prPopoverComments}`}
    >
      <div className={styles.prPopoverSectionLabel}>Comments</div>
      {shown.map((comment) => (
        <PrCommentCard
          key={comment.url}
          comment={comment}
          onSendToAgent={props.onSendToAgent}
        />
      ))}
      {hidden > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className={styles.prPopoverMore}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          {expanded ? "Show fewer" : `+${hidden} more`}
        </Button>
      )}
    </section>
  );
}

/**
 * The first message for an agent asked to deal with a review thread: the
 * comment, where it hangs, who left it, and the link back — enough that the
 * agent can find the code and report where it answered.
 */
function reviewCommentPrompt(pr: PrInfo, comment: PrComment): string {
  const where = comment.path ? ` on \`${comment.path}\`` : "";
  const who = comment.author ? `@${comment.author}` : "a reviewer";
  return [
    `Address this unresolved review comment${where} from ${who} on PR #${pr.number} (${pr.title}):`,
    comment.body.trim(),
    `Comment: ${comment.url}`,
  ].join(" ");
}
