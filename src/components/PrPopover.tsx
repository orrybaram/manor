import React, { useRef, useCallback, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  GitPullRequest,
  GitMerge,
  GitPullRequestClosed,
  CircleCheck,
  CircleX,
  Clock,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
} from "lucide-react";
import type { PrInfo } from "../store/project-store";
import styles from "./Sidebar.module.css";

interface PrPopoverProps {
  pr: PrInfo;
  onOpen: () => void;
}

const HOVER_DELAY = 300;

export function PrPopover({ pr, onOpen }: PrPopoverProps) {
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
    timeoutRef.current = setTimeout(() => setOpen(true), HOVER_DELAY);
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

  // Diff stats
  let diffElement: React.ReactNode = null;
  if (pr.additions != null || pr.deletions != null) {
    diffElement = (
      <div className={styles.prPopoverRow}>
        {pr.additions != null && (
          <span style={{ color: "var(--green)" }}>+{pr.additions}</span>
        )}
        {pr.deletions != null && (
          <span style={{ color: "var(--red)" }}>-{pr.deletions}</span>
        )}
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
          <PrIcon size={10} />
          #{pr.number}
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
          {diffElement}

          <div className={styles.prPopoverFooter}>Open in GitHub</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
