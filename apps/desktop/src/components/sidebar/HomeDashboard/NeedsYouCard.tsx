import { useState, type CSSProperties, type ReactNode } from "react";
import AlarmClock from "lucide-react/dist/esm/icons/alarm-clock";
import Bot from "lucide-react/dist/esm/icons/bot";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import GitPullRequest from "lucide-react/dist/esm/icons/git-pull-request";
import type { NeedsYouCard as NeedsYouCardData } from "../../../lib/home-dashboard-studio";
import type { ProjectInfo, WorkspaceInfo } from "../../../store/project-store";
import { useAppStore } from "../../../store/app-store";
import { navigateToAgent } from "../../../utils/agent-navigation";
import { startAgentInBackground } from "../../../lib/agent-prompt-launch";
import { toast } from "../../../toast";
import { ghRepoOf } from "../../../lib/gh-repo";
import { projectColorStyle } from "../../../hooks/useProjectHeaderRow";
import { Button } from "../../ui/Button/Button";
import { Link } from "../../ui/Link/Link";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import { CardContext } from "./CardContext";
import { savedPromptOverrides } from "../../../lib/prompts/saved-overrides";
import { fixPrPrompt, isFixable, type FixableContext } from "./fix-pr-prompt";
import { formatAge } from "./format";
import { needsYouKindLabel, needsYouTitle, cardColor } from "./needs-you-labels";
import styles from "./NeedsYouCards.module.css";

type FixWithAgentButtonProps = {
  pr: Extract<NeedsYouCardData, { pr: unknown }>["pr"];
  context: FixableContext;
  project: ProjectInfo;
  workspace: WorkspaceInfo;
  toastId: string;
  onStarted: () => void;
};

/**
 * Starts an agent on what's blocking the PR. Waits on GitHub for checks and
 * threads: their brief carries the failed logs and the threads' text, so it
 * can take a while, and a brief that can't be fetched starts nothing.
 */
function FixWithAgentButton(props: FixWithAgentButtonProps) {
  const { pr, context, project, workspace, toastId, onStarted } = props;
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
      className={primaryClass}
      disabled={preparing}
      onClick={() => void start()}
    >
      {preparing ? "Reading PR…" : "Fix with agent"}
    </Button>
  );
}

type NeedsYouCardProps = {
  card: NeedsYouCardData;
  /** Selects the workspace; false when it has since gone away. */
  onOpenWorkspace: (project: ProjectInfo, workspace: WorkspaceInfo) => boolean;
  onSnooze: (key: string) => void;
};

const primaryClass = `${styles.action} ${styles.primary}`;
const secondaryClass = `${styles.action} ${styles.secondary}`;
const toolClass = `${styles.action} ${styles.tool}`;

/**
 * One Needs you card: kind, project, age, title, the context
 * block and its actions (§4). The card itself isn't a button — only its
 * actions are focusable.
 */
export function NeedsYouCard(props: NeedsYouCardProps) {
  const { card, onOpenWorkspace, onSnooze } = props;

  const actions = cardActions(card, onOpenWorkspace, () => onSnooze(card.key));
  const title = needsYouTitle(card);
  const workspace = card.workspace;

  return (
    <article
      className={styles.card}
      style={{ "--c": cardColor(card) } as CSSProperties}
      aria-label={`${needsYouKindLabel(card)}: ${title}`}
    >
      <div className={styles.cardHeader}>
        <span className={styles.kind}>
          {card.kind === "agent" ? <Bot size={13} /> : <GitPullRequest size={13} />}
          {needsYouKindLabel(card)}
        </span>
        <span className={styles.proj} style={projectColorStyle(card.project.color)}>
          {card.project.name}
        </span>
        {card.ageMs != null && <span className={styles.when}>{formatAge(card.ageMs)}</span>}
      </div>
      <h3 className={styles.title}>{title}</h3>
      <CardContext context={card.context} />
      <div className={styles.footer}>
        {actions.primary}
        {actions.secondary}
        <div className={styles.tools}>
          {workspace && (
            <Tooltip label="Open workspace" side="top">
              <Button
                variant="ghost"
                size="sm"
                className={toolClass}
                aria-label="Open workspace"
                onClick={() => onOpenWorkspace(card.project, workspace)}
              >
                <GitBranch size={13} />
              </Button>
            </Tooltip>
          )}
          <Tooltip label="Snooze for 1 hour" side="top">
            <Button
              variant="ghost"
              size="sm"
              className={toolClass}
              aria-label="Snooze for 1 hour"
              onClick={() => onSnooze(card.key)}
            >
              <AlarmClock size={13} />
            </Button>
          </Tooltip>
        </div>
      </div>
    </article>
  );
}

type CardActions = { primary: ReactNode; secondary: ReactNode };

/**
 * A card's primary and secondary action. Open workspace and
 * Snooze sit in every card's icon row, so they aren't repeated here.
 * Taking the primary action dismisses the card (a snooze, so it returns
 * if it still needs the user once the snooze lapses).
 */
function cardActions(
  card: NeedsYouCardData,
  onOpenWorkspace: (project: ProjectInfo, workspace: WorkspaceInfo) => boolean,
  dismiss: () => void,
): CardActions {
  if (card.kind === "agent") {
    const focus = (label: string) => (
      <Button
        variant="primary"
        size="sm"
        className={primaryClass}
        onClick={() => {
          navigateToAgent(card.agent);
          dismiss();
        }}
      >
        {label}
      </Button>
    );
    if (card.tier !== "finished") return { primary: focus("Focus agent"), secondary: null };
    // `navigateToAgent` marks the agent seen, which clears the card.
    const workspace = card.workspace;
    const openDiff = workspace ? (
      <Button
        variant="secondary"
        size="sm"
        className={secondaryClass}
        onClick={() => {
          // Same order as the sidebar's "Open Source Control": select, then
          // open (or focus) it in the now-active workspace.
          if (onOpenWorkspace(card.project, workspace)) {
            useAppStore.getState().openSourceControl();
          }
        }}
      >
        Source Control
      </Button>
    ) : null;
    return { primary: focus("Review"), secondary: openDiff };
  }

  const { pr, workspace, project, context } = card;
  const openPr = (className: string, onClick?: () => void) => (
    <Link href={pr.url} variant="plain" className={className} onClick={onClick}>
      Open PR
    </Link>
  );

  if (!isFixable(context)) {
    // Ready to merge. No GitHub merge API yet: merging happens on GitHub.
    return { primary: openPr(primaryClass, dismiss), secondary: null };
  }

  const firstRun =
    context.kind === "checks" ? context.failing.find((run) => run.url != null)?.url : undefined;
  return {
    primary: (
      <FixWithAgentButton
        pr={pr}
        context={context}
        project={project}
        workspace={workspace}
        toastId={`fix-pr-${card.key}`}
        onStarted={dismiss}
      />
    ),
    secondary:
      context.kind === "checks" ? (
        <Link href={firstRun ?? `${pr.url}/checks`} variant="plain" className={secondaryClass}>
          View check
        </Link>
      ) : (
        openPr(secondaryClass)
      ),
  };
}
