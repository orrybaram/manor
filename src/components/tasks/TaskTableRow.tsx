import type { CSSProperties } from "react";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import FolderKanban from "lucide-react/dist/esm/icons/folder-kanban";
import Milestone from "lucide-react/dist/esm/icons/milestone";
import IterationCw from "lucide-react/dist/esm/icons/iteration-cw";
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
import { PriorityIcon } from "./PriorityIcon";
import { TrackerRowIcon } from "./tracker-icons";
import styles from "./TasksView.module.css";

const MAX_AVATARS = 3;

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
  /** The Assignees column; hidden while the Tasks view's drawer is open. */
  showAssignees?: boolean;
  /** Makes the title open the task's detail (ADR-208 §3) instead of its URL. */
  onOpen?: () => void;
  /** The row whose detail is open. */
  selected?: boolean;
};

/** One Tasks table row. Pair `compact` with the table's `.compact` class. */
export function TaskTableRow(props: TaskTableRowProps) {
  const {
    row,
    now,
    showPriority,
    actionLabel,
    onAction,
    compact = false,
    showAssignees = true,
    onOpen,
    selected = false,
  } = props;

  const shownAssignees = row.assignees.slice(0, MAX_AVATARS);
  const hiddenAssignees = row.assignees.length - shownAssignees.length;
  const updated = relativeTime(row.updatedAt, now);

  return (
    <div
      className={`${styles.gridRow} ${styles.bodyRow} ${selected ? styles.bodyRowSelected : ""}`}
      role="row"
      aria-selected={onOpen ? selected : undefined}
      data-testid="task-row"
      data-task-key={row.key}
    >
      <span role="cell" className={styles.actionCell}>
        <Button
          variant="secondary"
          size="sm"
          className={`${styles.startButton} ${actionLabel === "Start" ? styles.startButtonGo : ""}`}
          onClick={onAction}
          aria-label={`${actionLabel} ${row.displayId}`}
        >
          {actionLabel}
        </Button>
      </span>
      <span role="cell">
        <Link href={row.url} variant="plain" className={styles.idChip}>
          <TrackerRowIcon provider={row.provider} />
          {row.displayId}
        </Link>
      </span>
      <span role="cell" className={styles.titleCell}>
        {onOpen ? (
          <Button
            variant="ghost"
            className={`${styles.taskTitle} ${styles.taskTitleButton}`}
            onClick={onOpen}
            data-task-title=""
          >
            {row.title}
          </Button>
        ) : (
          <Link href={row.url} variant="plain" className={styles.taskTitle}>
            {row.title}
          </Link>
        )}
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
          {showAssignees && (
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
              {row.assignees.length === 0 && (
                <span className={styles.dim}>—</span>
              )}
            </span>
          )}
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
    </div>
  );
}

