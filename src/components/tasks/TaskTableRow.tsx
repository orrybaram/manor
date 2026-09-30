import type { CSSProperties } from "react";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right";
import CircleDot from "lucide-react/dist/esm/icons/circle-dot";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import FolderKanban from "lucide-react/dist/esm/icons/folder-kanban";
import Milestone from "lucide-react/dist/esm/icons/milestone";
import IterationCw from "lucide-react/dist/esm/icons/iteration-cw";
import { LinearIcon } from "../command-palette/LinearIcon";
import { Button } from "../ui/Button/Button";
import { Link } from "../ui/Link/Link";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import { projectColorStyle } from "../../hooks/useProjectHeaderRow";
import {
  initialOf,
  relativeTime,
  type LinkedTask,
  type TaskRow,
} from "../../lib/tasks";
import styles from "./TasksView.module.css";

const MAX_AVATARS = 3;

/** Linear's priority glyph: an alert square for Urgent, else 3 bars — High 3 lit, Medium 2, Low 1. */
function PriorityIcon(props: { value: number }) {
  const { value } = props;

  if (value === 1) {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        className={styles.priorityUrgent}
        aria-hidden
      >
        <rect x="1" y="1" width="14" height="14" rx="3" fill="currentColor" />
        <path
          d="M8 4.5v4.5"
          stroke="var(--bg)"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="8" cy="11.75" r="1.1" fill="var(--bg)" />
      </svg>
    );
  }
  const lit = 5 - value;
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      className={styles.priorityBars}
      aria-hidden
    >
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={1.5 + i * 5}
          y={10 - i * 4}
          width="3"
          height={5 + i * 4}
          rx="1"
          fill="currentColor"
          opacity={i < lit ? 1 : 0.3}
        />
      ))}
    </svg>
  );
}

type TaskTableRowProps = {
  row: TaskRow | LinkedTask;
  now: number;
  /** Linear's Priority column. */
  showPriority: boolean;
  /** "Start" for a tracker row, "Open" (go to its workspace) for a linked one. */
  actionLabel: string;
  onAction: () => void;
  /** Just ID, title / context, updated and the action — Home's Up next. */
  compact?: boolean;
};

/** One Tasks table row. Pair `compact` with the table's `.compact` class. */
export function TaskTableRow(props: TaskTableRowProps) {
  const { row, now, showPriority, actionLabel, onAction, compact = false } = props;

  const shownAssignees = row.assignees.slice(0, MAX_AVATARS);
  const hiddenAssignees = row.assignees.length - shownAssignees.length;
  const updated = relativeTime(row.updatedAt, now);

  return (
    <div
      className={`${styles.gridRow} ${styles.bodyRow}`}
      role="row"
      data-testid="task-row"
    >
      <span role="cell">
        <Link href={row.url} variant="plain" className={styles.idChip}>
          {row.provider === "github" ? (
            <CircleDot size={11} />
          ) : (
            <LinearIcon size={10} />
          )}
          {row.displayId}
        </Link>
      </span>
      <span role="cell" className={styles.titleCell}>
        <Link href={row.url} variant="plain" className={styles.taskTitle}>
          {row.title}
        </Link>
        <span className={styles.context}>
          <span
            className={styles.projectName}
            style={projectColorStyle(row.color)}
          >
            {row.projectName}
          </span>
          {"workspaceName" in row && (
            <span className={styles.workspaceName}>
              <GitBranch size={11} />
              {row.workspaceName}
            </span>
          )}
          {row.trackerProjects.map((name) => (
            <span key={`p:${name}`} className={styles.contextChip}>
              <FolderKanban size={11} aria-hidden />
              {name}
            </span>
          ))}
          {row.milestone && (
            <span className={styles.contextChip}>
              <Milestone size={11} aria-hidden />
              {row.milestone}
            </span>
          )}
          {row.cycle && (
            <span className={styles.contextChip}>
              <IterationCw size={11} aria-hidden />
              {row.cycle}
            </span>
          )}
          {row.author && <span className={styles.author}>by {row.author}</span>}
          {row.labels.map((label) => (
            <span
              key={label.name}
              className={styles.label}
              style={
                label.color
                  ? ({ "--label-color": label.color } as CSSProperties)
                  : undefined
              }
            >
              {label.name}
            </span>
          ))}
        </span>
      </span>
      {!compact && (
        <>
          <span role="cell" className={styles.avatars}>
            {shownAssignees.map((name) => (
              <Tooltip key={name} label={name}>
                <span className={styles.avatar} aria-label={name}>
                  {initialOf(name)}
                </span>
              </Tooltip>
            ))}
            {hiddenAssignees > 0 && (
              <span className={styles.avatarMore}>+{hiddenAssignees}</span>
            )}
            {row.assignees.length === 0 && <span className={styles.dim}>—</span>}
          </span>
          <span role="cell">
            <span
              className={`${styles.status} ${styles[`tone-${row.status.tone}`]}`}
            >
              {row.status.label}
            </span>
          </span>
          {showPriority && (
            <span role="cell" className={styles.priority}>
              {row.priority && row.priority.value > 0 ? (
                <>
                  <PriorityIcon value={row.priority.value} />
                  {row.priority.label}
                </>
              ) : (
                <span className={styles.dim}>—</span>
              )}
            </span>
          )}
        </>
      )}
      <span role="cell" className={styles.updated}>
        {updated || <span className={styles.dim}>—</span>}
      </span>
      <span role="cell" className={styles.actionCell}>
        <Button
          variant="secondary"
          size="sm"
          className={styles.startButton}
          onClick={onAction}
          aria-label={`${actionLabel} ${row.displayId}`}
        >
          {actionLabel}
          <ArrowRight size={13} />
        </Button>
      </span>
    </div>
  );
}

