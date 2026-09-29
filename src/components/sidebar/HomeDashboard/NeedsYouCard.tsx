import type { CSSProperties, ReactNode } from "react";
import Bot from "lucide-react/dist/esm/icons/bot";
import GitPullRequest from "lucide-react/dist/esm/icons/git-pull-request";
import type { NeedsYouCard as NeedsYouCardData } from "../../../lib/home-dashboard-studio";
import type { ProjectInfo, WorkspaceInfo } from "../../../store/project-store";
import { navigateToAgent } from "../../../utils/agent-navigation";
import { startAgentWithPrompt } from "../../../lib/agent-prompt-launch";
import { projectColorStyle } from "../../../hooks/useProjectHeaderRow";
import { Button } from "../../ui/Button/Button";
import { Link } from "../../ui/Link/Link";
import { CardContext } from "./CardContext";
import { fixChecksPrompt } from "./fix-checks-prompt";
import { formatAge } from "./format";
import { needsYouKindLabel, needsYouTitle, TIER_COLOR } from "./needs-you-labels";
import styles from "./NeedsYouCards.module.css";

type NeedsYouCardProps = {
  card: NeedsYouCardData;
  onOpenWorkspace: (project: ProjectInfo, workspace: WorkspaceInfo) => void;
  onSnooze: (key: string) => void;
};

const primaryClass = `${styles.action} ${styles.primary}`;
const secondaryClass = `${styles.action} ${styles.secondary}`;

/**
 * One Needs you card (ADR-198 §1.4): kind, project, age, title, the context
 * block and its actions (§4). The card itself isn't a button — only its
 * actions are focusable.
 */
export function NeedsYouCard(props: NeedsYouCardProps) {
  const { card, onOpenWorkspace, onSnooze } = props;

  const actions = cardActions(card, onOpenWorkspace);
  const title = needsYouTitle(card);

  return (
    <article
      className={styles.card}
      style={{ "--c": TIER_COLOR[card.tier] } as CSSProperties}
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
        <Button
          variant="ghost"
          size="sm"
          className={`${styles.action} ${styles.snooze}`}
          title="Snooze for 1 hour"
          onClick={() => onSnooze(card.key)}
        >
          Snooze
        </Button>
      </div>
    </article>
  );
}

type CardActions = { primary: ReactNode; secondary: ReactNode };

/** A card's primary and secondary action, per ADR-198 §4's table. */
function cardActions(
  card: NeedsYouCardData,
  onOpenWorkspace: (project: ProjectInfo, workspace: WorkspaceInfo) => void,
): CardActions {
  const openWorkspace = (workspace: WorkspaceInfo | undefined) =>
    workspace ? (
      <Button
        variant="secondary"
        size="sm"
        className={secondaryClass}
        onClick={() => onOpenWorkspace(card.project, workspace)}
      >
        Open workspace
      </Button>
    ) : null;

  if (card.kind === "agent") {
    const focus = (label: string) => (
      <Button
        variant="primary"
        size="sm"
        className={primaryClass}
        onClick={() => navigateToAgent(card.agent)}
      >
        {label}
      </Button>
    );
    switch (card.tier) {
      case "input":
        return { primary: focus("Focus agent"), secondary: null };
      case "error":
        return { primary: focus("Focus agent"), secondary: openWorkspace(card.workspace) };
      case "finished":
        // `navigateToAgent` marks the agent seen, which clears the card.
        return { primary: focus("Review"), secondary: openWorkspace(card.workspace) };
    }
  }

  const { pr, workspace, project, context } = card;
  const openPr = (className: string) => (
    <Link href={pr.url} variant="plain" className={className}>
      Open PR
    </Link>
  );

  if (context.kind === "checks") {
    const firstRun = context.failing.find((run) => run.url != null)?.url;
    return {
      primary: (
        <Button
          variant="primary"
          size="sm"
          className={primaryClass}
          onClick={() =>
            startAgentWithPrompt(
              workspace.path,
              fixChecksPrompt(pr, context.failing, context.failingCount),
              project.hostId,
            )
          }
        >
          Fix with agent
        </Button>
      ),
      secondary: (
        <Link href={firstRun ?? `${pr.url}/checks`} variant="plain" className={secondaryClass}>
          View check
        </Link>
      ),
    };
  }

  if (context.kind === "ready") {
    // No GitHub merge API yet (ADR-198 Context): merging happens on GitHub.
    return { primary: openPr(primaryClass), secondary: openWorkspace(workspace) };
  }

  // Conflicts, changes requested, unresolved threads: the work is in the workspace.
  return {
    primary: (
      <Button
        variant="primary"
        size="sm"
        className={primaryClass}
        onClick={() => onOpenWorkspace(project, workspace)}
      >
        Open workspace
      </Button>
    ),
    secondary: openPr(secondaryClass),
  };
}
