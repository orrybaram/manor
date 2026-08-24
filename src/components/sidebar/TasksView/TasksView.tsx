import { useState, useCallback, useEffect, useRef, memo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import X from "lucide-react/dist/esm/icons/x";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import type { TaskInfo } from "../../../electron.d";
import { useTaskStore } from "../../../store/task-store";
import { AgentDot } from "../../ui/AgentDot/AgentDot";
import { useTaskDisplay } from "../../../hooks/useTaskDisplay";
import { relativeShortThenDate } from "../../../utils/relative-time";
import { BUCKET_ORDER, getDateBucket, type DateBucket } from "../../../utils/date-buckets";
import styles from "./TasksView.module.css";

// ── Helpers ──

type StatusFilter = "all" | "active" | "completed";

function matchesFilter(task: TaskInfo, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return task.status === "active";
  if (filter === "completed")
    return (
      task.status === "completed" ||
      task.status === "error" ||
      task.status === "abandoned"
    );
  return true;
}

// ── Components ──

type TaskViewRowProps = {
  task: TaskInfo;
  onResumeTask: (task: TaskInfo) => void;
  onRemoveTask: (taskId: string) => void;
};

const TaskViewRow = memo(function TaskViewRow(props: TaskViewRowProps) {
  const { task, onResumeTask, onRemoveTask } = props;

  const { title, status } = useTaskDisplay(task);

  return (
    <button className={styles.taskRow} onClick={() => onResumeTask(task)}>
      <AgentDot status={status} size="sidebar" />
      <span className={styles.taskName}>{title}</span>
      <span className={styles.taskProject}>
        {task.projectName || "No Project"}
      </span>
      <span className={styles.taskTime}>
        {relativeShortThenDate(new Date(task.updatedAt).getTime())}
      </span>
      <span
        role="button"
        tabIndex={0}
        className={styles.removeButton}
        onClick={(e) => {
          e.stopPropagation();
          onRemoveTask(task.id);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            onRemoveTask(task.id);
          }
        }}
      >
        <Trash2 size={12} />
      </span>
    </button>
  );
});

// ── Modal Component ──

type TasksModalProps = {
  open: boolean;
  onClose: () => void;
  onResumeTask: (task: TaskInfo) => void;
};

export function TasksModal(props: TasksModalProps) {
  const { open, onClose, onResumeTask } = props;

  const {
    tasks,
    loading,
    loaded,
    hasMore,
    loadingMore,
    removeTask,
    loadMoreTasks,
  } = useTaskStore();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const handleResume = useCallback(
    (task: TaskInfo) => {
      onClose();
      onResumeTask(task);
    },
    [onClose, onResumeTask],
  );

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) onClose();
    },
    [onClose],
  );

  // When the bottom sentinel scrolls into view, request the next page.
  // The store's `loadMoreTasks` coalesces overlapping calls and short-circuits
  // when `hasMore` is false, so the observer firing more than once is safe.
  useEffect(() => {
    if (!open) return;
    if (!hasMore) return;
    const node = sentinelRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            loadMoreTasks(tasks.length);
            break;
          }
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [open, hasMore, tasks.length, loadMoreTasks]);

  const filtered = tasks.filter((t) => matchesFilter(t, filter));

  // Group by date bucket, then by project within each bucket
  const grouped = new Map<DateBucket, Map<string, TaskInfo[]>>();

  for (const task of filtered) {
    const bucket = getDateBucket(task.createdAt);
    let projectMap = grouped.get(bucket);
    if (!projectMap) {
      projectMap = new Map<string, TaskInfo[]>();
      grouped.set(bucket, projectMap);
    }
    const projectKey = task.projectName || "No Project";
    let list = projectMap.get(projectKey);
    if (!list) {
      list = [];
      projectMap.set(projectKey, list);
    }
    list.push(task);
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.modal}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            document
              .querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
              ?.focus();
          }}
        >
          <div className={styles.header}>
            <Dialog.Title className={styles.title}>Tasks</Dialog.Title>
            <div className={styles.filterTabs}>
              {(["all", "active", "completed"] as const).map((f) => (
                <button
                  key={f}
                  className={`${styles.filterTab} ${filter === f ? styles.filterTabActive : ""}`}
                  onClick={() => setFilter(f)}
                >
                  {f === "all"
                    ? "All"
                    : f === "active"
                      ? "Active"
                      : "Completed"}
                </button>
              ))}
            </div>
            <Dialog.Close asChild>
              <button className={styles.closeButton}>
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <div className={styles.scrollArea}>
            {loading && !loaded && (
              <div className={styles.loading}>Loading tasks...</div>
            )}

            {loaded && filtered.length === 0 && (
              <div className={styles.empty}>No tasks found.</div>
            )}

            {BUCKET_ORDER.map((bucket) => {
              const projectMap = grouped.get(bucket);
              if (!projectMap) return null;

              return (
                <div key={bucket} className={styles.dateGroup}>
                  <div className={styles.dateGroupHeader}>{bucket}</div>
                  {Array.from(projectMap.entries()).map(
                    ([projectName, projectTasks]) => (
                      <div key={projectName} className={styles.projectGroup}>
                        <div className={styles.projectGroupHeader}>
                          {projectName}
                        </div>
                        {projectTasks.map((task) => (
                          <TaskViewRow
                            key={task.id}
                            task={task}
                            onResumeTask={handleResume}
                            onRemoveTask={removeTask}
                          />
                        ))}
                      </div>
                    ),
                  )}
                </div>
              );
            })}

            {hasMore && (
              <div
                ref={sentinelRef}
                data-testid="tasks-load-more-sentinel"
                className={styles.loadMore}
                aria-hidden="true"
              >
                {loadingMore ? "Loading more..." : ""}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
