import { useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up";
import MessageSquare from "lucide-react/dist/esm/icons/message-square";
import Plus from "lucide-react/dist/esm/icons/plus";
import type { AgentInfo, AgentStatus } from "../../../electron.d";
import type { DraftComment } from "../../../store/review-store";
import { adapterForKind } from "../../../lib/harness";
import { agentLabel, type ReviewTarget } from "../../../lib/review-submit";
import { Button } from "../../ui/Button/Button";
import { AgentDot } from "../../ui/AgentDot/AgentDot";
import {
  commentFile,
  countLabel,
  useDiscardConfirm,
  useReviewSend,
  type ReviewSend,
} from "./useReviewSend";
import styles from "./ReviewSend.module.css";

/**
 * The floating control for a review in progress: "N comments ▴" (the jump
 * list) and Send, with Discard where asked for. Only there once there is
 * something to send.
 */
export function ReviewBar({
  workspacePath,
  hostId,
  onJumpToComment,
  discard = false,
  testIds,
}: {
  workspacePath: string;
  /** The workspace's host: a review sent to a new agent runs there. */
  hostId?: string;
  /** Show a comment. Owned by the pane that renders the bar. */
  onJumpToComment: (comment: DraftComment) => void;
  discard?: boolean;
  testIds?: { bar: string; list: string; send: string };
}) {
  const review = useReviewSend(workspacePath, hostId);
  const count = review.comments.length;
  if (count === 0) return null;

  return (
    <div className={styles.bar} data-testid={testIds?.bar}>
      <CommentJumpList
        comments={review.comments}
        onJump={onJumpToComment}
        testId={testIds?.list}
        trigger={
          <Button variant="ghost" size="sm" className={styles.count} aria-label="Jump to a comment">
            <MessageSquare size={11} />
            {countLabel(count)}
            <ChevronUp size={11} className={styles.countCaret} />
          </Button>
        }
      />
      {discard && (
        <DiscardReviewButton workspacePath={workspacePath} count={count} className={styles.barDiscard} />
      )}
      <SendSplitButton review={review} testId={testIds?.send} />
    </div>
  );
}

/**
 * Send the review: the body goes to the default destination, the caret opens
 * the picker (each live agent in the workspace, then a new one).
 */
export function SendSplitButton({
  review,
  testId,
  className,
}: {
  review: ReviewSend;
  testId?: string;
  className?: string;
}) {
  const { agents, defaultTarget, send } = review;
  const [open, setOpen] = useState(false);
  const pick = (target: ReviewTarget) => {
    setOpen(false);
    send(target);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <span className={`${styles.split} ${className ?? ""}`}>
        <Button
          variant="primary"
          size="sm"
          className={styles.submit}
          data-testid={testId}
          onClick={() => pick(defaultTarget)}
        >
          {defaultTarget.kind === "agent"
            ? `Send to ${agentLabel(defaultTarget.agent)}`
            : "Send to new agent"}
        </Button>
        <Popover.Trigger asChild>
          <Button
            variant="primary"
            size="sm"
            className={styles.caret}
            aria-label="Choose where to send this review"
          >
            <ChevronUp size={12} />
          </Button>
        </Popover.Trigger>
      </span>
      <AgentTargetMenu agents={agents} onPick={pick} />
    </Popover.Root>
  );
}

/**
 * The destinations a "Send to…" control offers, as a popover's content: each
 * live agent in the workspace, then a new one, then whatever `children` adds
 * under a separator (a browser pane's notes add Copy to clipboard).
 */
export function AgentTargetMenu({
  agents,
  onPick,
  children,
  testId,
}: {
  agents: AgentInfo[];
  onPick: (target: ReviewTarget) => void;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <Popover.Portal>
      <Popover.Content
        className={styles.menu}
        side="top"
        align="end"
        sideOffset={6}
        collisionPadding={8}
        data-testid={testId}
      >
        {agents.map((agent) => (
          <AgentRow key={agent.id} agent={agent} onSelect={() => onPick({ kind: "agent", agent })} />
        ))}
        {agents.length > 0 && <div className={styles.separator} />}
        <Button
          variant="ghost"
          size="sm"
          className={styles.row}
          onClick={() => onPick({ kind: "new" })}
        >
          <Plus size={12} className={styles.rowIcon} />
          <span className={styles.rowName}>New agent</span>
        </Button>
        {children && (
          <>
            <div className={styles.separator} />
            {children}
          </>
        )}
      </Popover.Content>
    </Popover.Portal>
  );
}

/** One more row in an `AgentTargetMenu`, after New agent. */
export function AgentTargetMenuItem({
  icon,
  label,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  onSelect: () => void;
}) {
  return (
    <Button variant="ghost" size="sm" className={styles.row} onClick={onSelect}>
      <span className={styles.rowIcon}>{icon}</span>
      <span className={styles.rowName}>{label}</span>
    </Button>
  );
}

/**
 * One destination. The dot and the "will interrupt" hint are the only warning
 * the user gets that sending into a busy agent ends its current turn — there
 * is no confirmation step, by design.
 */
function AgentRow(props: { agent: AgentInfo; onSelect: () => void }) {
  const { agent, onSelect } = props;

  const busy = !adapterForKind(agent.agentKind).isIdle(agent.lastAgentStatus);

  return (
    <Button variant="ghost" size="sm" className={styles.row} onClick={onSelect}>
      <span className={styles.rowIcon}>
        <AgentDot
          status={(agent.lastAgentStatus as AgentStatus | null) ?? undefined}
          size="sidebar"
          pulse={false}
        />
      </span>
      <span className={styles.rowName}>{agentLabel(agent)}</span>
      {busy && <span className={styles.rowHint}>will interrupt current turn</span>}
    </Button>
  );
}

/** Throw the workspace's drafts away, on a second click. */
export function DiscardReviewButton({
  workspacePath,
  count,
  testId,
  className,
}: {
  workspacePath: string;
  count: number;
  testId?: string;
  className?: string;
}) {
  const { confirming, press } = useDiscardConfirm(workspacePath);
  return (
    <Button
      variant="ghost"
      size="sm"
      className={`${styles.discard} ${className ?? ""}`}
      data-testid={testId}
      onClick={press}
    >
      {confirming ? `Discard ${countLabel(count)}?` : "Discard"}
    </Button>
  );
}

/**
 * The drafts as a popover list over `trigger`, each a way back to its
 * comment: a comment can be anywhere in a long diff, or in another file.
 */
function CommentJumpList({
  comments,
  onJump,
  trigger,
  testId,
}: {
  comments: DraftComment[];
  onJump: (comment: DraftComment) => void;
  /** The button that opens it. */
  trigger: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={`${styles.menu} ${styles.commentMenu}`}
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          data-testid={testId}
        >
          {comments.map((comment) => (
            <Button
              key={comment.id}
              variant="ghost"
              size="sm"
              className={styles.commentRow}
              onClick={() => {
                setOpen(false);
                onJump(comment);
              }}
            >
              <span className={styles.commentWhere}>
                <span className={styles.commentFile}>{commentFile(comment)}</span>
                {comment.startLabel && (
                  <span className={styles.commentAnchor}>{comment.startLabel}</span>
                )}
              </span>
              <span className={styles.commentBody}>{comment.body.trim()}</span>
            </Button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
