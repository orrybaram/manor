import { useContext, useState } from "react";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { Button } from "../../ui/Button/Button";
import { formatElapsed, resultPreview, type TaskItem } from "./chat-entries";
import { TaskViewContext } from "./task-view-context";
import { TaskStatusDot } from "./TaskStatusDot";
import styles from "./ChatPane.module.css";

type TaskCardProps = {
  task: TaskItem;
};

/**
 * A delegated or background task: status dot, title, agent type,
 * and the time it has run, or a line of what it found. A task with a
 * transcript opens it in the chat's task view; one without (a foreground
 * agent still running, a shell command) expands its result inline.
 */
export function TaskCard(props: TaskCardProps) {
  const { task } = props;

  const [open, setOpen] = useState(false);
  const taskView = useContext(TaskViewContext);
  const running = task.display === "running";
  const preview = running ? null : resultPreview(task.result);
  const hasView = taskView !== null && task.hasTranscript === true;
  const expandable = !hasView && Boolean(task.result);

  return (
    <div
      className={styles.taskCard}
      data-testid="chat-task"
      data-task-status={task.display}
      data-task-id={task.id}
      data-viewed={taskView?.viewedId === task.id || undefined}
    >
      <Button
        variant="ghost"
        size="sm"
        className={styles.taskLine}
        aria-expanded={expandable ? open : undefined}
        disabled={!hasView && !expandable}
        onClick={() => (hasView ? taskView.open(task.id) : setOpen((v) => !v))}
      >
        <TaskStatusDot status={task.display} />
        <span className={styles.taskTitle}>{task.title}</span>
        {task.agentType && <span className={styles.taskChip}>{task.agentType}</span>}
        {task.background && <span className={styles.taskBackground}>background</span>}
        {running && <TaskElapsed since={task.ts} />}
        {(hasView || expandable) && (
          <ChevronRight className={styles.taskChevron} size={14} aria-hidden />
        )}
      </Button>
      {preview && !open && <div className={styles.taskPreview}>{preview}</div>}
      {open && expandable && <pre className={styles.toolDetail}>{task.result}</pre>}
    </div>
  );
}

/** Time since `since`, ticking each second. Mounted only while the task runs. */
function TaskElapsed(props: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useMountEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  });
  const seconds = (now - Date.parse(props.since)) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return <span className={styles.toolElapsed}>{formatElapsed(seconds)}</span>;
}
