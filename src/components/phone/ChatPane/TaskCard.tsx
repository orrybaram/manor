import { useState } from "react";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import type { ChatEntry } from "../../../electron.d";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { Button } from "../../ui/Button/Button";
import {
  resultPreview,
  formatElapsed,
  TASK_DOT,
  TASK_LABEL,
  type TaskDisplayStatus,
} from "./chat-entries";
import { TaskSheet } from "./TaskSheet";
import styles from "./ChatPane.module.css";

type TaskEntry = Extract<ChatEntry, { kind: "task" }>;

type TaskCardProps = {
  paneId: string;
  entry: TaskEntry;
  /** A running task that can no longer be trusted to be (see `staleTaskIds`). */
  stale: boolean;
};

/**
 * A delegated or background task (ADR-224 D4): status dot, title, agent type,
 * and the time it has run, or a line of what it found. A task with a
 * transcript opens it in a sheet; one without (a foreground agent still
 * running, a shell command) expands its result inline.
 */
export function TaskCard(props: TaskCardProps) {
  const { paneId, entry, stale } = props;

  const [open, setOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const status: TaskDisplayStatus = stale ? "unknown" : entry.status;
  const preview = status === "running" ? null : resultPreview(entry.result);
  const hasSheet = entry.hasTranscript;
  const expandable = !hasSheet && Boolean(entry.result);

  return (
    <div
      className={styles.taskCard}
      data-testid="chat-task"
      data-task-status={status}
      data-task-id={entry.id}
    >
      <Button
        variant="ghost"
        size="sm"
        className={styles.taskLine}
        aria-expanded={expandable ? open : undefined}
        disabled={!hasSheet && !expandable}
        onClick={() => (hasSheet ? setSheetOpen(true) : setOpen((v) => !v))}
      >
        <span
          className={styles.statusDot}
          data-status={TASK_DOT[status]}
          role="img"
          aria-label={TASK_LABEL[status]}
        />
        <span className={styles.taskTitle}>{entry.title}</span>
        {entry.agentType && <span className={styles.taskChip}>{entry.agentType}</span>}
        {entry.background && <span className={styles.taskBackground}>background</span>}
        {status === "running" && <TaskElapsed since={entry.ts} />}
        {(hasSheet || expandable) && (
          <ChevronRight className={styles.taskChevron} size={14} aria-hidden />
        )}
      </Button>
      {preview && !open && <div className={styles.taskPreview}>{preview}</div>}
      {open && expandable && <pre className={styles.toolDetail}>{entry.result}</pre>}
      {hasSheet && (
        <TaskSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          paneId={paneId}
          entry={entry}
          status={status}
        />
      )}
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
