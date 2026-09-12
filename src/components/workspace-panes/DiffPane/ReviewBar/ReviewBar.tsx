import { useCallback, useEffect, useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import MessageSquare from "lucide-react/dist/esm/icons/message-square";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up";
import Plus from "lucide-react/dist/esm/icons/plus";
import type { AgentInfo, AgentStatus } from "../../../../electron.d";
import { useAgentStore } from "../../../../store/agent-store";
import { useReviewStore, NO_DRAFTS } from "../../../../store/review-store";
import { adapterForKind } from "../../../../lib/harness";
import {
  agentLabel,
  submitReview,
  type ReviewTarget,
} from "../../../../lib/review-submit";
import { Button } from "../../../ui/Button/Button";
import { AgentDot } from "../../../ui/AgentDot/AgentDot";
import styles from "./ReviewBar.module.css";

type ReviewBarProps = { workspacePath: string };

/** How long "Discard 3 comments?" waits for its "Yes" before backing out. */
const CONFIRM_TIMEOUT = 4000;

/**
 * The floating submit control for a review in progress.
 *
 * Batching is the whole point (ADR-172): one interrupt per review rather than
 * one per remark. So the bar only appears once there is something to send, and
 * the split button's body carries the default destination — the most recently
 * updated agent already running in this workspace — so the common case is one
 * click and the popover is the override.
 */
export function ReviewBar(props: ReviewBarProps) {
  const { workspacePath } = props;

  const drafts = useReviewStore((s) => s.drafts[workspacePath] ?? NO_DRAFTS);
  const allAgents = useAgentStore((s) => s.agents);

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const comments = useMemo(
    () => drafts.filter((d) => d.body.trim() !== ""),
    [drafts],
  );

  /**
   * Filtered here rather than inside the selector: a selector that builds a
   * new array on every store read would re-render on every unrelated agent
   * update.
   */
  const agents = useMemo(
    () =>
      allAgents
        .filter(
          (a) =>
            a.workspacePath === workspacePath &&
            a.status === "active" &&
            a.paneId,
        )
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [allAgents, workspacePath],
  );

  const submit = useCallback(
    (target: ReviewTarget) => {
      setMenuOpen(false);
      submitReview(workspacePath, comments, target);
      useReviewStore.getState().clearWorkspace(workspacePath);
    },
    [workspacePath, comments],
  );

  /** A confirm that is never answered should go away, not sit there armed. */
  useEffect(() => {
    if (!confirmingDiscard) return;
    const timer = setTimeout(
      () => setConfirmingDiscard(false),
      CONFIRM_TIMEOUT,
    );
    return () => clearTimeout(timer);
  }, [confirmingDiscard]);

  const handleDiscard = useCallback(() => {
    if (!confirmingDiscard) {
      setConfirmingDiscard(true);
      return;
    }
    setConfirmingDiscard(false);
    useReviewStore.getState().clearWorkspace(workspacePath);
  }, [confirmingDiscard, workspacePath]);

  if (comments.length === 0) return null;

  const count = comments.length;
  const countLabel = count === 1 ? "1 comment" : `${count} comments`;
  const defaultAgent: AgentInfo | undefined = agents[0];
  const defaultTarget: ReviewTarget = defaultAgent
    ? { kind: "agent", agent: defaultAgent }
    : { kind: "new" };

  return (
    <div className={styles.bar}>
      <span className={styles.count}>
        <MessageSquare size={11} />
        {countLabel}
      </span>

      <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <span className={styles.split}>
          <Button
            variant="primary"
            size="sm"
            className={styles.submit}
            onClick={() => submit(defaultTarget)}
          >
            {defaultAgent
              ? `Submit to ${agentLabel(defaultAgent)}`
              : "Submit review"}
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
        <Popover.Portal>
          <Popover.Content
            className={styles.menu}
            side="top"
            align="end"
            sideOffset={6}
            collisionPadding={8}
          >
            {agents.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                onSelect={() => submit({ kind: "agent", agent })}
              />
            ))}
            {agents.length > 0 && <div className={styles.separator} />}
            <Button
              variant="ghost"
              size="sm"
              className={styles.row}
              onClick={() => submit({ kind: "new" })}
            >
              <Plus size={12} className={styles.rowIcon} />
              <span className={styles.rowName}>New agent</span>
            </Button>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <Button variant="ghost" size="sm" onClick={handleDiscard}>
        {confirmingDiscard ? `Discard ${countLabel}?` : "Discard"}
      </Button>
    </div>
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
      {busy && (
        <span className={styles.rowHint}>will interrupt current turn</span>
      )}
    </Button>
  );
}
