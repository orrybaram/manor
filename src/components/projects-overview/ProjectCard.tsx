import type { NeedsYouTier, ProjectCardSummary } from "../../lib/home-dashboard";
import { projectColorStyle } from "../../hooks/useProjectHeaderRow";
import { Button } from "../ui/Button/Button";
import styles from "./ProjectsOverview.module.css";

/** The status-dot class per Needs-you tier (red / yellow / green / cyan). */
const TIER_DOT: Record<NeedsYouTier, string> = {
  input: styles.dotAttention,
  error: styles.dotAttention,
  blocked: styles.dotBlocked,
  ready: styles.dotReady,
  finished: styles.dotFinished,
};

interface ProjectCardProps {
  summary: ProjectCardSummary;
  onOpen: () => void;
}

/**
 * One top-level sidebar entry (a project, or a linked group) on the Projects
 * overview (ADR-194 §2): name, host, path, counts and up to three pending
 * workspaces. All content comes from `projectCardSummary()`.
 */
export function ProjectCard(props: ProjectCardProps) {
  const { summary, onOpen } = props;

  return (
    <Button
      variant="ghost"
      className={styles.card}
      onClick={onOpen}
      data-testid="project-card"
      aria-label={`Open ${summary.name}`}
    >
      <span className={styles.cardHeader}>
        <span
          className={`${styles.cardName} ${summary.color ? styles.cardNameColored : ""}`}
          style={projectColorStyle(summary.color)}
        >
          {summary.name}
        </span>
        <span className={styles.cardHost}>{summary.hostLabel}</span>
      </span>
      <span className={styles.cardPath} title={summary.path}>
        {summary.path}
      </span>
      <span className={styles.cardStats}>
        {summary.needsYou > 0 && (
          <span className={styles.statHot}>
            <b>{summary.needsYou}</b> need{summary.needsYou === 1 ? "s" : ""} you
          </span>
        )}
        <span>
          <b>{summary.workspaceCount}</b> workspace
          {summary.workspaceCount === 1 ? "" : "s"}
        </span>
        <span>
          <b>{summary.runningAgents}</b> running
        </span>
        <span>
          <b>{summary.openPrs}</b> PR{summary.openPrs === 1 ? "" : "s"}
        </span>
      </span>
      <span className={styles.cardPending}>
        {summary.pending.length > 0 ? (
          summary.pending.map((item) => (
            <span key={`${item.name}:${item.tier}`} className={styles.pendingRow}>
              <span className={`${styles.dot} ${TIER_DOT[item.tier]}`} />
              <span className={styles.pendingName}>{item.name}</span>
              <span className={styles.pendingLabel}>{item.label}</span>
            </span>
          ))
        ) : (
          <span className={styles.pendingQuiet}>Nothing open</span>
        )}
      </span>
    </Button>
  );
}
