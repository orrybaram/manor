import React, { useRef, useCallback, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Button } from "../ui/Button/Button";
import GitPullRequest from "lucide-react/dist/esm/icons/git-pull-request";
import GitMerge from "lucide-react/dist/esm/icons/git-merge";
import GitPullRequestClosed from "lucide-react/dist/esm/icons/git-pull-request-closed";
import CircleCheck from "lucide-react/dist/esm/icons/circle-check";
import CircleX from "lucide-react/dist/esm/icons/circle-x";
import Clock from "lucide-react/dist/esm/icons/clock";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert";
import ShieldQuestion from "lucide-react/dist/esm/icons/shield-question";
import MessageSquare from "lucide-react/dist/esm/icons/message-square";
import type { PrInfo } from "../../store/project-store";
import { fetchPrs } from "../../hooks/usePrWatcher";
import styles from "./Sidebar/Sidebar.module.css";

type PrPopoverProps = {
  pr: PrInfo;
  onOpen: () => void;
};

const HOVER_DELAY = 300;

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

  const badgeClass =
    pr.state === "merged"
      ? styles.prMerged
      : pr.state === "closed"
        ? styles.prClosed
        : styles.prOpen;

  // Status dot on badge
  const hasUnresolved =
    pr.unresolvedThreads != null && pr.unresolvedThreads > 0;
  const allChecksPassing =
    pr.checks != null && pr.checks.failing === 0 && pr.checks.pending === 0;
  const isApproved = pr.reviewDecision === "APPROVED";
  const isAllGreen =
    pr.state === "open" && allChecksPassing && isApproved && !hasUnresolved;

  let dotClass: string | null = null;
  if (hasUnresolved) {
    dotClass = styles.prBadgeDotWarning;
  } else if (isAllGreen) {
    dotClass = styles.prBadgeDotSuccess;
  }

  // CI checks summary
  let checksElement: React.ReactNode = null;
  if (pr.checks) {
    const { total, passing, failing, pending } = pr.checks;
    let checksText: string;
    let checksColor: string;
    let ChecksIcon: typeof CircleCheck;

    if (failing > 0) {
      checksText = `${failing} failing, ${passing} passing`;
      checksColor = "var(--red)";
      ChecksIcon = CircleX;
    } else if (pending > 0) {
      checksText = `${pending} pending, ${passing} passing`;
      checksColor = "var(--yellow, #eab308)";
      ChecksIcon = Clock;
    } else {
      checksText = `${passing}/${total} passing`;
      checksColor = "var(--green)";
      ChecksIcon = CircleCheck;
    }

    checksElement = (
      <div className={styles.prPopoverRow} style={{ color: checksColor }}>
        <ChecksIcon size={12} />
        <span>{checksText}</span>
      </div>
    );
  }

  // Review decision
  let reviewElement: React.ReactNode = null;
  if (pr.reviewDecision) {
    let reviewText: string;
    let reviewColor: string;
    let ReviewIcon: typeof ShieldCheck;

    switch (pr.reviewDecision) {
      case "APPROVED":
        reviewText = "Approved";
        reviewColor = "var(--green)";
        ReviewIcon = ShieldCheck;
        break;
      case "CHANGES_REQUESTED":
        reviewText = "Changes requested";
        reviewColor = "var(--red)";
        ReviewIcon = ShieldAlert;
        break;
      default:
        reviewText = "Review required";
        reviewColor = "var(--yellow, #eab308)";
        ReviewIcon = ShieldQuestion;
        break;
    }

    reviewElement = (
      <div className={styles.prPopoverRow} style={{ color: reviewColor }}>
        <ReviewIcon size={12} />
        <span>{reviewText}</span>
      </div>
    );
  }

  // Unresolved comments
  let commentsElement: React.ReactNode = null;
  if (pr.unresolvedThreads != null && pr.unresolvedThreads > 0) {
    commentsElement = (
      <div
        className={styles.prPopoverRow}
        style={{ color: "var(--yellow, #eab308)" }}
      >
        <MessageSquare size={12} />
        <span>{pr.unresolvedThreads} unresolved</span>
      </div>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <span
          className={`${styles.prBadge} ${badgeClass}`}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          <PrIcon size={10} />#{pr.number}
          {dotClass && <span className={dotClass} />}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={styles.prPopover}
          side="right"
          sideOffset={8}
          align="start"
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
          </div>

          <div className={styles.prPopoverTitle}>{pr.title}</div>

          {checksElement}
          {reviewElement}
          {commentsElement}

          <Button
            variant="secondary"
            size="sm"
            className={styles.prPopoverFooterButton}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              window.electronAPI.shell.openExternal(pr.url);
            }}
          >
            Open in GitHub
          </Button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
