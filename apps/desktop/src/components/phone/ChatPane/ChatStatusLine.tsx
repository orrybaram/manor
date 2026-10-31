import { useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import Bars from "lucide-react/dist/esm/icons/chart-no-axes-column-increasing";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import GitPullRequest from "lucide-react/dist/esm/icons/git-pull-request";
import GitPullRequestDraft from "lucide-react/dist/esm/icons/git-pull-request-draft";
import { useShallow } from "zustand/react/shallow";
import type { ChatSessionInfo } from "../../../electron.d";
import type { LayoutMode } from "../../../hooks/useLayoutMode";
import { find } from "../../../lib/workspace-directory";
import { selectActiveWorkspaceKey, useAppStore } from "../../../store/app-store";
import { useProjectStore } from "../../../store/project-store";
import { AnimatedCount } from "../../ui/AnimatedCount/AnimatedCount";
import { Button } from "../../ui/Button/Button";
import { Link } from "../../ui/Link/Link";
import { PhoneSheet, PhoneSheetClose } from "../PhoneSheet";
import {
  branchChip,
  formatContextTokens,
  modelDisplayName,
  runningChipLabel,
  shortBranchName,
  statusLineModel,
  type BranchChip,
} from "./chat-status-line";
import { PhonePrSheet } from "./PhonePrSheet";
import styles from "./ChatPane.module.css";

/**
 * The line under the chat's input, as chips: the active workspace's branch,
 * the session's model and effort, the workspace's open pull request (number,
 * opening a drawer), its CI (linking to GitHub), the diff stat (opening
 * Source Control) and the running tasks, so "2 failing" is in view while you
 * ask Claude to fix it. The session's context size sits on the right.
 * Renders nothing when none of them has anything to show; a chip with
 * nothing to show is left out.
 *
 * The desk reads branch, model and effort first. A phone leads with what it
 * acts on (branch, running, CI, PR, diff) and scrolls the chips sideways
 * rather than wrapping, the context size pinned outside the scroll.
 *
 * The branch is the workspace's live one. When the transcript's newest line
 * says the agent is on another, the chip is tinted and marked "≠"; tapping
 * it explains, in a sheet on a phone and a popover on the desk.
 *
 * Keyed off the active workspace: a phone only ever shows that one, and a
 * background workspace's chat is mounted but hidden. That holds for the
 * branch too: the chat in view is the active workspace's.
 */
type ChatStatusLineProps = {
  /** The session's context size in tokens, or null if not known. */
  contextTokens?: number | null;
  /** How many tasks are running in the chat. */
  runningTasks?: number;
  /** The session's model, effort and transcript branch, or null if not known. */
  session?: ChatSessionInfo | null;
  /** The pane's layout: it orders the chips, and scrolls them on a phone. */
  layout?: LayoutMode;
};

type ChipName = "branch" | "model" | "effort" | "pr" | "ci" | "diff" | "running";

const DESK_ORDER: ChipName[] = ["branch", "model", "effort", "pr", "ci", "diff", "running"];
const PHONE_ORDER: ChipName[] = ["branch", "running", "ci", "pr", "diff", "model", "effort"];

export function ChatStatusLine(props: ChatStatusLineProps) {
  const { contextTokens, runningTasks = 0, session, layout = "phone" } = props;
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
  const running = runningChipLabel(runningTasks);
  const branch = branchChip(workspace?.branch, session?.gitBranch);
  const model = session?.model ? modelDisplayName(session.model) : null;
  const effort = session?.effort || null;
  if (!pr && !ci && !diff && !hasTokens && !running && !branch && !model && !effort) return null;

  const phone = layout === "phone";
  const draft = pr?.isDraft === true;
  const PrIcon = draft ? GitPullRequestDraft : GitPullRequest;

  const chips: Record<ChipName, ReactNode> = {
    branch: branch && (
      <BranchChipButton key="branch" chip={branch} phone={phone} model={model} effort={effort} />
    ),
    model: model && (
      <span
        key="model"
        className={styles.statusChip}
        data-plain=""
        title={session?.model ?? undefined}
        data-testid="chat-model-chip"
      >
        {model}
      </span>
    ),
    effort: effort && (
      <span
        key="effort"
        className={styles.statusChip}
        data-plain=""
        aria-label={`Effort ${effort}`}
        data-testid="chat-effort-chip"
      >
        <Bars size={11} className={styles.statusEffortIcon} />
        {effort}
      </span>
    ),
    pr: pr && (
      <Button
        key="pr"
        variant="ghost"
        className={styles.statusChip}
        aria-label={`Pull request #${pr.number}: ${pr.title}`}
        onClick={() => setPrOpen(true)}
      >
        <PrIcon size={11} className={styles.statusPrIcon} data-draft={draft || undefined} />
        {`#${pr.number}`}
      </Button>
    ),
    ci: ci && (
      <Link
        key="ci"
        variant="plain"
        href={ci.url}
        className={styles.statusChip}
        data-tone={ci.tone}
        aria-label={`Checks ${ci.tone}`}
      >
        <span className={styles.statusDot} />
        {ci.label}
      </Link>
    ),
    diff: diff && (
      <Button
        key="diff"
        variant="ghost"
        className={styles.statusChip}
        aria-label={`${diff.additions} additions, ${diff.deletions} deletions`}
        onClick={() => useAppStore.getState().openSourceControl()}
      >
        <AnimatedCount className={styles.statusAdditions} prefix="+" value={diff.additions} />
        <AnimatedCount className={styles.statusDeletions} prefix="−" value={diff.deletions} />
      </Button>
    ),
    running: running && (
      <Button
        key="running"
        variant="ghost"
        className={styles.statusChip}
        data-testid="chat-running-chip"
        data-tone="pending"
        onClick={(e) => scrollToNewestRunningTask(e.currentTarget)}
      >
        <span className={styles.statusDot} />
        {running}
      </Button>
    ),
  };

  return (
    <div className={styles.statusLine} data-layout={layout} data-testid="chat-status-line">
      <div className={styles.statusChips} data-testid="chat-status-chips">
        {(phone ? PHONE_ORDER : DESK_ORDER).map((name) => chips[name])}
      </div>
      {pr && (
        <PhonePrSheet
          open={prOpen}
          onOpenChange={setPrOpen}
          pr={pr}
          workspacePath={workspace?.path}
          hostId={hostId}
        />
      )}
      {hasTokens && (
        <span
          className={styles.statusTokens}
          title={`${contextTokens.toLocaleString()} tokens`}
          aria-label={`${contextTokens} tokens in context`}
        >
          <AnimatedCount value={contextTokens} format={formatContextTokens} />
        </span>
      )}
    </div>
  );
}

type BranchChipButtonProps = {
  chip: BranchChip;
  phone: boolean;
  model: string | null;
  effort: string | null;
};

/**
 * The branch chip, and what tapping it opens: the workspace's branch, the
 * model and effort, and, when the transcript says otherwise, the branch the
 * agent is on. A bottom sheet on a phone, a popover on the desk.
 */
function BranchChipButton(props: BranchChipButtonProps) {
  const { chip, phone, model, effort } = props;
  const [open, setOpen] = useState(false);
  const mismatch = chip.agentBranch !== null;
  const label = phone ? shortBranchName(chip.branch) : chip.branch;
  const button = (
    <Button
      variant="ghost"
      className={styles.statusChip}
      data-mismatch={mismatch || undefined}
      data-testid="chat-branch-chip"
      title={chip.branch}
      aria-label={
        mismatch
          ? `Branch ${chip.branch}; the agent's transcript says ${chip.agentBranch}`
          : `Branch ${chip.branch}`
      }
      onClick={phone ? () => setOpen(true) : undefined}
    >
      <GitBranch size={11} className={styles.statusBranchIcon} />
      <span className={styles.statusBranchName}>{label}</span>
      {mismatch && " ≠"}
    </Button>
  );
  const details = <SessionDetails chip={chip} model={model} effort={effort} />;

  if (phone) {
    return (
      <>
        {button}
        <PhoneSheet
          open={open}
          onOpenChange={setOpen}
          variant="bottom"
          hiddenTitle="Session"
          data-testid="chat-session-sheet"
        >
          <div className={styles.sessionSheetHeader}>
            <PhoneSheetClose label="Close" />
          </div>
          <div className={styles.sessionSheetBody}>{details}</div>
        </PhoneSheet>
      </>
    );
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{button}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={styles.sessionPopover}
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          data-testid="chat-session-popover"
        >
          {details}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function SessionDetails(props: { chip: BranchChip; model: string | null; effort: string | null }) {
  const { chip, model, effort } = props;
  return (
    <div className={styles.sessionDetails}>
      <dl className={styles.sessionRows}>
        <dt>Branch</dt>
        <dd>{chip.branch}</dd>
        {model && (
          <>
            <dt>Model</dt>
            <dd>{model}</dd>
          </>
        )}
        {effort && (
          <>
            <dt>Effort</dt>
            <dd>{effort}</dd>
          </>
        )}
      </dl>
      {chip.agentBranch !== null && (
        <p className={styles.sessionMismatch} data-testid="chat-branch-mismatch">
          The agent's transcript says it's on <code>{chip.agentBranch}</code>.
        </p>
      )}
    </div>
  );
}

/** Scroll the chat holding `from` to its newest running task card. */
function scrollToNewestRunningTask(from: HTMLElement): void {
  const cards = from
    .closest("[data-chat-pane]")
    ?.querySelectorAll('[data-task-id][data-task-status="running"]');
  cards?.[cards.length - 1]?.scrollIntoView({ block: "center", behavior: "smooth" });
}
