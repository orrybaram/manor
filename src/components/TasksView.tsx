import { useState, useCallback, memo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { TaskInfo, AgentStatus, TaskStatus } from "../electron.d";
import { useTaskStore } from "../store/task-store";
import { AgentDot } from "./AgentDot";
import styles from "./TasksView.module.css";

// ── Helpers ──

type DateBucket = "Today" | "Yesterday" | "This Week" | "This Month" | "Older";
type StatusFilter = "all" | "active" | "completed";

const BUCKET_ORDER: DateBucket[] = [
  "Today",
  "Yesterday",
  "This Week",
  "This Month",
  "Older",
];

const PAGE_SIZE = 50;

function getDateBucket(dateStr: string): DateBucket {
  const date = new Date(dateStr);
  const now = new Date();

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  if (date >= startOfToday) return "Today";
  if (date >= startOfYesterday) return "Yesterday";
  if (date >= startOfWeek) return "This Week";
  if (date >= startOfMonth) return "This Month";
  return "Older";
}

function mapTaskStatusToAgentStatus(task: TaskInfo): AgentStatus | undefined {
  if (task.status === "active" && task.lastAgentStatus) {
    return task.lastAgentStatus as AgentStatus;
  }

  const statusMap: Record<TaskStatus, AgentStatus> = {
    active: "working",
    completed: "complete",
    error: "error",
    abandoned: "idle",
  };

  return statusMap[task.status];
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function matchesFilter(task: TaskInfo, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return task.status === "active";
  if (filter === "completed") return task.status === "completed" || task.status === "error" || task.status === "abandoned";
  return true;
}

// ── Components ──

interface TaskRowProps {
  task: TaskInfo;
  onResumeTask: (task: TaskInfo) => void;
}

const TaskRow = memo(function TaskRow({ task, onResumeTask }: TaskRowProps) {
  const agentStatus = mapTaskStatusToAgentStatus(task);

  return (
    <button
      className={styles.taskRow}
      onClick={() => onResumeTask(task)}
    >
      <AgentDot status={agentStatus} size="sidebar" />
      <span className={styles.taskName}>
        {task.name || "Untitled Session"}
      </span>
      <span className={styles.taskProject}>
        {task.projectName || "No Project"}
      </span>
      <span className={styles.taskTime}>
        {formatRelativeTime(task.updatedAt)}
      </span>
    </button>
  );
});

// ── Modal Component ──

interface TasksModalProps {
  open: boolean;
  onClose: () => void;
  onResumeTask: (task: TaskInfo) => void;
}

export function TasksModal({ open, onClose, onResumeTask }: TasksModalProps) {
  const { tasks, loading, loaded, loadMoreTasks } = useTaskStore();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [offset, setOffset] = useState(PAGE_SIZE);

  const handleLoadMore = useCallback(() => {
    loadMoreTasks(offset);
    setOffset((prev) => prev + PAGE_SIZE);
  }, [offset, loadMoreTasks]);

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
                  {f === "all" ? "All" : f === "active" ? "Active" : "Completed"}
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
                          <TaskRow
                            key={task.id}
                            task={task}
                            onResumeTask={handleResume}
                          />
                        ))}
                      </div>
                    ),
                  )}
                </div>
              );
            })}

            {loaded && filtered.length > 0 && (
              <button
                className={styles.loadMore}
                onClick={handleLoadMore}
                disabled={loading}
              >
                {loading ? "Loading..." : "Load more"}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
