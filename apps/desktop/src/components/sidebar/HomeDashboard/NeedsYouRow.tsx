import { useState, type CSSProperties, type ReactNode } from "react";
import AlarmClock from "lucide-react/dist/esm/icons/alarm-clock";
import CircleCheck from "lucide-react/dist/esm/icons/circle-check";
import CircleHelp from "lucide-react/dist/esm/icons/circle-help";
import CircleX from "lucide-react/dist/esm/icons/circle-x";
import GitMerge from "lucide-react/dist/esm/icons/git-merge";
import GitMergeConflict from "lucide-react/dist/esm/icons/git-merge-conflict";
import MessageSquare from "lucide-react/dist/esm/icons/message-square";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert";
import type {
  NeedsYouCard as NeedsYouCardData,
  NeedsYouCardContext,
} from "../../../lib/home-dashboard-studio";
import type { ProjectInfo, WorkspaceInfo } from "../../../store/project-store";
import { navigateToAgent } from "../../../utils/agent-navigation";
import { startAgentInBackground } from "../../../lib/agent-prompt-launch";
import { fetchPrs } from "../../../hooks/usePrWatcher";
import { toast } from "../../../toast";
import { ghRepoOf } from "../../../lib/gh-repo";
import { projectColorStyle } from "../../../hooks/useProjectHeaderRow";
import { Button } from "../../ui/Button/Button";
import { Link } from "../../ui/Link/Link";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import { PrPopover } from "../PrPopover";
import { savedPromptOverrides } from "../../../lib/prompts/saved-overrides";
import { fixPrPrompt, isFixable, type FixableContext } from "./fix-pr-prompt";
import { formatAge } from "./format";
import { needsYouKindLabel, needsYouTitle, cardColor } from "./needs-you-labels";
import styles from "./NeedsYouList.module.css";

type PrCard = Extract<NeedsYouCardData, { kind: "pr" }>;

/** Named failing checks in a row's context before "+N more"; it stays one line. */
const CHECK_NAMES_SHOWN = 2;

const KIND_ICON: Record<NeedsYouCardContext["kind"], typeof CircleX> = {
  input: CircleHelp,
  error: CircleX,
  checks: CircleX,
  conflicts: GitMergeConflict,
  "changes-requested": ShieldAlert,
  threads: MessageSquare,
  ready: GitMerge,
  finished: CircleCheck,
};

type NeedsYouRowProps = {
  card: NeedsYouCardData;
  /** Selects the workspace; false when it has since gone away. */
  onOpenWorkspace: (project: ProjectInfo, workspace: WorkspaceInfo) => boolean;
  onSnooze: (key: string) => void;
};

/**
 * One Needs you row: kind, title (opens the workspace) over project · agent
 * or PR, why it needs the user, age, one primary action and Snooze.
 */
export function NeedsYouRow(props: NeedsYouRowProps) {
  const { card, onOpenWorkspace, onSnooze } = props;

  const title = needsYouTitle(card);
  const kindLabel = needsYouKindLabel(card);
  const KindIcon = KIND_ICON[card.context.kind];
  const workspace = card.workspace;
  const dismiss = () => onSnooze(card.key);

  return (
    <li
      className={styles.row}
      style={{ "--c": cardColor(card) } as CSSProperties}
      aria-label={`${kindLabel}: ${title}`}
    >
      <span className={styles.kind}>
        <KindIcon size={13} aria-hidden />
        {kindLabel}
      </span>
      <div className={styles.main}>
        {workspace ? (
          <button
            type="button"
            className={`${styles.title} ${styles.titleButton}`}
            title={`Open workspace: ${title}`}
            onClick={() => onOpenWorkspace(card.project, workspace)}
          >
            {title}
          </button>
        ) : (
          <span className={styles.title} title={title}>
            {title}
          </span>
        )}
        <span className={styles.sub}>
          <span className={styles.proj} style={projectColorStyle(card.project.color)}>
            {card.project.name}
          </span>
          {" · "}
          {card.kind === "pr" ? (
            <Link
              href={card.pr.url}
              variant="plain"
              className={styles.prLink}
              title="Open PR on GitHub"
            >
              PR #{card.pr.number}
            </Link>
          ) : (
            "agent"
          )}
        </span>
      </div>
      <RowContext card={card} />
      <span className={styles.age}>{card.ageMs != null ? formatAge(card.ageMs) : ""}</span>
      <div className={styles.actions}>
        {primaryAction(card, dismiss)}
        <Tooltip label="Snooze for 1 hour" side="top">
          <Button
            variant="ghost"
            size="sm"
            className={`${styles.action} ${styles.snooze}`}
            aria-label="Snooze for 1 hour"
            onClick={dismiss}
          >
            <AlarmClock size={14} />
          </Button>
        </Tooltip>
      </div>
    </li>
  );
}

/**
 * The row's one action. Taking it dismisses the row (a snooze, so it comes
 * back if it still needs the user once the snooze lapses) — except Merge,
 * which only opens the PR popover; a merged PR leaves Needs you by itself.
 */
function primaryAction(card: NeedsYouCardData, dismiss: () => void): ReactNode {
  if (card.kind === "agent") {
    // `navigateToAgent` marks a finished agent seen, which clears the row.
    return (
      <Button
        variant="primary"
        size="sm"
        className={styles.action}
        onClick={() => {
          navigateToAgent(card.agent);
          dismiss();
        }}
      >
        {card.tier === "finished" ? "Review" : "Focus agent"}
      </Button>
    );
  }
  if (!isFixable(card.context)) return <MergeButton card={card} />;
  return (
    <FixWithAgentButton
      card={card}
      context={card.context}
      toastId={`fix-pr-${card.key}`}
      onStarted={dismiss}
    />
  );
}

/** Opens the PR popover, whose footer holds the merge controls, on the button. */
function MergeButton(props: { card: PrCard }) {
  const { pr, workspace, project } = props.card;
  const [open, setOpen] = useState(false);

  return (
    <PrPopover
      pr={pr}
      workspacePath={workspace.path}
      hostId={project.hostId}
      onOpen={() => setOpen(true)}
      open={open}
      onOpenChange={setOpen}
      side="bottom"
    >
      <Button
        variant="primary"
        size="sm"
        className={styles.action}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          if (!open) fetchPrs();
          setOpen(!open);
        }}
      >
        Merge
      </Button>
    </PrPopover>
  );
}

type FixWithAgentButtonProps = {
  card: PrCard;
  context: FixableContext;
  toastId: string;
  onStarted: () => void;
};

/**
 * Starts an agent on what's blocking the PR. Waits on GitHub for checks and
 * threads: their brief carries the failed logs and the threads' text, so it
 * can take a while, and a brief that can't be fetched starts nothing.
 */
function FixWithAgentButton(props: FixWithAgentButtonProps) {
  const { card, context, toastId, onStarted } = props;
  const { pr, project, workspace } = card;
  const [preparing, setPreparing] = useState(false);

  const start = async () => {
    setPreparing(true);
    try {
      const prompt = await fixPrPrompt(
        pr,
        context,
        (task) => window.electronAPI.github.getPrAgentPrompt(ghRepoOf(project), pr.number, task),
        savedPromptOverrides(),
      );
      // Stay on the Dashboard: the agent works in the background, and
      // the toast says so.
      startAgentInBackground(workspace.path, prompt, project.hostId);
      toast.info(`Agent is fixing #${pr.number}`, {
        id: toastId,
        detail: `Working in ${workspace.name ?? workspace.branch}. It shows up here again if it needs you.`,
      });
      onStarted();
    } catch (err) {
      toast.error(`Couldn't start an agent on #${pr.number}`, { id: toastId, error: err });
      setPreparing(false);
    }
  };

  return (
    <Button
      variant="primary"
      size="sm"
      className={styles.action}
      disabled={preparing} onClick={() => void start()}>
      {preparing ? "Reading PR…" : "Fix with agent"}
    </Button>
  );
}

/** The row's one-line "why", mono and ellipsised; failing checks and a thread link out. */
function RowContext(props: { card: NeedsYouCardData }) {
  const { card } = props;
  const context = card.context;
  const plain = (text: string, tone?: string) => (
    <span className={`${styles.context}${tone ? ` ${tone}` : ""}`} title={text}>
      {text}
    </span>
  );

  switch (context.kind) {
    case "input":
      return context.paneTitle
        ? plain(context.paneTitle, styles.strong)
        : plain("Waiting for your answer in its terminal", styles.dim);
    case "error":
      return context.paneTitle
        ? plain(context.paneTitle, styles.err)
        : plain("The agent stopped with an error", styles.dim);
    case "checks": {
      const shown = context.failing.slice(0, CHECK_NAMES_SHOWN).map((run) => run.name);
      const more = context.failingCount - shown.length;
      const text =
        shown.length > 0
          ? `✕ ${shown.join(", ")}${more > 0 ? ` +${more} more` : ""}`
          : `✕ ${context.failingCount} failing`;
      const firstRun = context.failing.find((run) => run.url != null)?.url;
      const prUrl = card.kind === "pr" ? card.pr.url : null;
      const href = firstRun ?? (prUrl ? `${prUrl}/checks` : null);
      if (!href) return plain(text, styles.err);
      return (
        <Link
          href={href}
          variant="plain"
          className={`${styles.context} ${styles.err} ${styles.contextLink}`}
          title={`View check: ${text}`}
          aria-label={`View check: ${text}`}
        >
          {text}
        </Link>
      );
    }
    case "conflicts":
      return plain("Conflicts with the base branch", styles.err);
    case "changes-requested":
      return plain("A reviewer requested changes", styles.strong);
    case "threads": {
      if (!context.comment) {
        return plain(
          `${context.count} unresolved thread${context.count === 1 ? "" : "s"}`,
          styles.strong,
        );
      }
      const { author, snippet, url } = context.comment;
      const text = `${author || "A reviewer"}: “${snippet}”`;
      return (
        <Link
          href={url}
          variant="plain"
          className={`${styles.context} ${styles.contextLink}`}
          title={text}
        >
          {text}
        </Link>
      );
    }
    case "ready": {
      const checks =
        context.checksTotal > 0 ? `${context.checksPassing}/${context.checksTotal} checks` : "no checks";
      return plain(context.approved ? `approved · ${checks}` : checks, styles.dim);
    }
    case "finished": {
      if (!context.diff) return plain("Finished, ready to review", styles.dim);
      const { added, removed } = context.diff;
      return (
        <span className={styles.context} title={`+${added} −${removed} lines changed`}>
          <span className={styles.ok}>+{added}</span> <span className={styles.err}>−{removed}</span>
        </span>
      );
    }
  }
}
