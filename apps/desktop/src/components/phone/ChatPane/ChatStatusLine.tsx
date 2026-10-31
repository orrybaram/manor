import { useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Bars from "lucide-react/dist/esm/icons/chart-no-axes-column-increasing";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import GitPullRequest from "lucide-react/dist/esm/icons/git-pull-request";
import GitPullRequestDraft from "lucide-react/dist/esm/icons/git-pull-request-draft";
import { useShallow } from "zustand/react/shallow";
import { useMountEffect } from "../../../hooks/useMountEffect";
import type { ChatSessionInfo } from "../../../electron.d";
import type { LayoutMode } from "../../../hooks/useLayoutMode";
import { find } from "../../../lib/workspace-directory";
import { selectActiveWorkspaceKey, useAppStore } from "../../../store/app-store";
import { useProjectStore } from "../../../store/project-store";
import { AnimatedCount } from "../../ui/AnimatedCount/AnimatedCount";
import { Button } from "../../ui/Button/Button";
import { Link } from "../../ui/Link/Link";
import { PhoneSheet, PhoneSheetClose } from "../PhoneSheet";
import type { TaskItem } from "./chat-entries";
import {
  agentsChipLabel,
  agentsListTitle,
  agentStatusText,
  branchChip,
  formatContextTokens,
  modelDisplayName,
  runningChipLabel,
  shortBranchName,
  statusLineModel,
  taskChips,
  type BranchChip,
} from "./chat-status-line";
import { PhonePrSheet } from "./PhonePrSheet";
import { revealTaskCard } from "./reveal-task";
import { TaskStatusDot } from "./TaskStatusDot";
import styles from "./ChatPane.module.css";

/**
 * The line under the chat's input, as chips: the active workspace's branch,
 * the session's model and effort, the workspace's open pull request (number,
 * opening a drawer), its CI (linking to GitHub), the diff stat (opening
 * Source Control), the background agents and other running tasks, so "2
 * failing" is in view while you ask Claude to fix it. The session's context
 * size sits on the right.
 * Renders nothing when none of them has anything to show; a chip with
 * nothing to show is left out.
 *
 * The desk reads branch, model and effort first. A phone leads with what it
 * acts on (branch, agents, CI, PR, diff) and scrolls the chips sideways
 * rather than wrapping, the context size pinned outside the scroll.
 *
 * While background agents run, "2 agents" opens a list of every background
 * agent in the chat (a sheet on a phone, a popover on the desk); picking
 * one brings its card into view. Any other task still running (a background
 * shell command, a foreground agent) keeps "1 running", which scrolls to the
 * newest of them.
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
  /** The chat's tasks, each with the status it shows. */
  tasks?: readonly TaskItem[];
  /**
   * Bring a task's card into view, picked from the agents list. Without it,
   * the card is looked for among what's mounted.
   */
  onRevealTask?: (id: string) => void;
  /** The session's model, effort and transcript branch, or null if not known. */
  session?: ChatSessionInfo | null;
  /** The pane's layout: it orders the chips, and scrolls them on a phone. */
  layout?: LayoutMode;
};

type ChipName = "branch" | "model" | "effort" | "pr" | "ci" | "diff" | "agents" | "running";

const DESK_ORDER: ChipName[] = ["branch", "model", "effort", "pr", "ci", "diff", "agents", "running"];
const PHONE_ORDER: ChipName[] = ["branch", "agents", "running", "ci", "pr", "diff", "model", "effort"];

const NO_TASKS: readonly TaskItem[] = [];

export function ChatStatusLine(props: ChatStatusLineProps) {
  const { contextTokens, tasks = NO_TASKS, onRevealTask, session, layout = "phone" } = props;
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
  const [agentsOpen, setAgentsOpen] = useState(false);
  const lineRef = useRef<HTMLDivElement>(null);
  const { pr, ci, diff } = statusLineModel({
    pr: workspace?.pr,
    diffStats: workspace?.diffStats,
  });
  const hasTokens = contextTokens != null;
  const { agents, runningAgents, runningOthers } = taskChips(tasks);
  // Kept while its list is open, so the last agent finishing doesn't yank it.
  // With no agent left to list (a /clear), the list closes for good rather
  // than open again on the next agent's chip.
  if (agentsOpen && agents.length === 0) setAgentsOpen(false);
  const showAgents = runningAgents > 0 || (agentsOpen && agents.length > 0);
  const running = runningChipLabel(runningOthers.length);
  const newestOther = runningOthers[runningOthers.length - 1];
  const reveal = (id: string) => {
    if (onRevealTask) onRevealTask(id);
    else revealTaskCard(lineRef.current?.closest("[data-chat-pane]"), id);
  };
  const branch = branchChip(workspace?.branch, session?.gitBranch);
  const model = session?.model ? modelDisplayName(session.model) : null;
  const effort = session?.effort || null;
  if (!pr && !ci && !diff && !hasTokens && !running && !showAgents && !branch && !model && !effort) {
    return null;
  }

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
    agents: showAgents && (
      <AgentsChip
        key="agents"
        agents={agents}
        running={runningAgents}
        phone={phone}
        open={agentsOpen}
        onOpenChange={setAgentsOpen}
        onPick={(id) => {
          setAgentsOpen(false);
          reveal(id);
        }}
      />
    ),
    running: running && (
      <Button
        key="running"
        variant="ghost"
        className={styles.statusChip}
        data-testid="chat-running-chip"
        data-tone="pending"
        onClick={() => newestOther && reveal(newestOther.id)}
      >
        <span className={styles.statusDot} />
        {running}
      </Button>
    ),
  };

  return (
    <div
      ref={lineRef}
      className={styles.statusLine}
      data-layout={layout}
      data-testid="chat-status-line"
    >
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

type AgentsChipProps = {
  /** The chat's background agents, running first. */
  agents: TaskItem[];
  /** How many of them run. */
  running: number;
  phone: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A row was picked: close the list and bring the agent's card into view. */
  onPick: (id: string) => void;
};

/**
 * The agents chip, and the list it opens: every background agent in the
 * chat, running first. A bottom sheet on a phone, a popover on the desk.
 */
function AgentsChip(props: AgentsChipProps) {
  const { agents, running, phone, open, onOpenChange, onPick } = props;
  const title = agentsListTitle(running);
  const button = (
    <Button
      variant="ghost"
      className={styles.statusChip}
      data-testid="chat-agents-chip"
      data-tone={running > 0 ? "pending" : undefined}
      aria-label={`${agentsChipLabel(running)} running in the background`}
      onClick={phone ? () => onOpenChange(true) : undefined}
    >
      <span className={styles.statusDot} />
      {agentsChipLabel(running)}
    </Button>
  );
  const list = <AgentsList agents={agents} onPick={onPick} />;

  if (phone) {
    return (
      <>
        {button}
        <PhoneSheet
          open={open}
          onOpenChange={onOpenChange}
          variant="bottom"
          data-testid="chat-agents-sheet"
        >
          <div className={styles.agentsSheetHeader}>
            <Dialog.Title className={styles.agentsTitle}>{title}</Dialog.Title>
            <PhoneSheetClose label="Close" />
          </div>
          <div className={styles.agentsSheetBody}>{list}</div>
        </PhoneSheet>
      </>
    );
  }
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{button}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={styles.agentsPopover}
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          aria-label={title}
          data-testid="chat-agents-popover"
        >
          <h2 className={styles.agentsTitle}>{title}</h2>
          {list}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The agents, one row each: status dot, title, type and time. Mounted only
 * while the list is open, so only an open list ticks the running times.
 */
function AgentsList(props: { agents: TaskItem[]; onPick: (id: string) => void }) {
  const { agents, onPick } = props;
  const [now, setNow] = useState(() => Date.now());
  useMountEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  });
  return (
    <div className={styles.agentsList} data-testid="chat-agents-list">
      {agents.map((task) => (
        <Button
          key={task.id}
          variant="ghost"
          className={styles.agentRow}
          data-testid="chat-agent-row"
          data-agent-id={task.id}
          onClick={() => onPick(task.id)}
        >
          <TaskStatusDot status={task.display} />
          <span className={styles.agentRowText}>
            <span className={styles.agentRowTitle}>{task.title}</span>
            <span className={styles.agentRowStatus}>{agentStatusText(task, now)}</span>
          </span>
          <ChevronRight size={14} className={styles.agentRowChevron} aria-hidden />
        </Button>
      ))}
    </div>
  );
}
