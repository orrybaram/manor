import { useState, useMemo } from "react";
import { ChevronRight, ListChecks, X } from "lucide-react";
import type { AgentStatus, TaskInfo, TaskStatus } from "../electron.d";
import { useTaskStore } from "../store/task-store";
import { useAppStore } from "../store/app-store";
import { AgentDot } from "./AgentDot";
import { useDebouncedAgentStatus } from "./useDebouncedAgentStatus";
import { allPaneIds } from "../store/pane-tree";
import { navigateToTask } from "../utils/task-navigation";
import styles from "./Sidebar.module.css";

const STATUS_LABEL: Record<string, string> = {
  thinking: "Thinking",
  working: "Working",
  responded: "Ready",
  complete: "Done",
  requires_input: "Waiting",
  error: "Error",
};

function AgentItemLabel({ status }: { status: AgentStatus }) {
  const debounced = useDebouncedAgentStatus(status);
  return (
    <span className={styles.agentStatusLabel}>
      {STATUS_LABEL[debounced ?? ""] ?? debounced}
    </span>
  );
}

function taskAgentStatus(task: TaskInfo): AgentStatus | undefined {
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

/** Priority order for picking the "most relevant" agent status to show collapsed */
const STATUS_PRIORITY: Record<string, number> = {
  error: 0,
  requires_input: 1,
  thinking: 2,
  working: 3,
  responded: 4,
  complete: 5,
  idle: 6,
};

function mostRelevantStatus(tasks: TaskInfo[]): AgentStatus | undefined {
  let best: AgentStatus | undefined;
  let bestPri = Infinity;
  for (const task of tasks) {
    const s = taskAgentStatus(task);
    if (!s) continue;
    const pri = STATUS_PRIORITY[s] ?? 99;
    if (pri < bestPri) {
      bestPri = pri;
      best = s;
    }
  }
  return best;
}

export function TasksList({ onShowAll }: { onShowAll?: () => void }) {
  const { tasks } = useTaskStore();
  const workspaceSessions = useAppStore((s) => s.workspaceSessions);
  const [collapsed, setCollapsed] = useState(false);

  // Collect all active pane IDs across all workspace sessions
  const activePaneIds = useMemo(() => {
    const ids = new Set<string>();
    for (const ws of Object.values(workspaceSessions)) {
      for (const session of ws.sessions) {
        for (const id of allPaneIds(session.rootNode)) {
          ids.add(id);
        }
      }
    }
    return ids;
  }, [workspaceSessions]);

  // Show active tasks always; show completed/error/abandoned only if their pane is still active
  const visibleTasks = useMemo(
    () =>
      tasks.filter(
        (t) =>
          t.status === "active" ||
          (t.paneId != null && activePaneIds.has(t.paneId)),
      ),
    [tasks, activePaneIds],
  );

  // Group tasks by projectName
  const groups = useMemo(() => {
    const map = new Map<string, TaskInfo[]>();
    for (const task of visibleTasks) {
      const key = task.projectName ?? "Unknown";
      let list = map.get(key);
      if (!list) {
        list = [];
        map.set(key, list);
      }
      list.push(task);
    }
    return map;
  }, [visibleTasks]);

  const collapsedStatus = useMemo(
    () => (collapsed ? mostRelevantStatus(visibleTasks) : undefined),
    [collapsed, visibleTasks],
  );

  return (
    <div className={styles.tasksSection}>
      <div
        className={styles.sectionHeader}
        style={{ cursor: "pointer" }}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span
            className={`${styles.projectChevron} ${!collapsed ? styles.projectChevronOpen : ""}`}
          >
            <ChevronRight size={12} />
          </span>
          <ListChecks size={12} />
          Tasks
          {collapsed && collapsedStatus && (
            <AgentDot status={collapsedStatus} size="sidebar" />
          )}
        </span>
        {onShowAll && (
          <button
            className={styles.action}
            onClick={(e) => {
              e.stopPropagation();
              onShowAll();
            }}
            title="View all tasks"
            style={{ fontSize: 10, opacity: 0.6 }}
          >
            View All
          </button>
        )}
      </div>
      {!collapsed && visibleTasks.length > 0 && (
        <div className={styles.taskGroups}>
          {Array.from(groups.entries()).map(([projectName, groupTasks]) => (
            <div key={projectName} className={styles.taskGroup}>
              <div className={styles.taskGroupHeader}>{projectName}</div>
              {groupTasks.map((task) => {
                const agentStatus = taskAgentStatus(task);
                return (
                  <button
                    key={task.id}
                    className={styles.agentItem}
                    onClick={() => navigateToTask(task)}
                  >
                    <AgentDot status={agentStatus} size="sidebar" />
                    <span className={styles.agentName}>
                      {task.name || "Agent"}
                    </span>
                    <span
                      className={styles.taskClose}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (task.paneId) {
                          useAppStore.getState().closePaneById(task.paneId);
                        } else {
                          useTaskStore.getState().removeTask(task.id);
                        }
                      }}
                      title="Close session"
                    >
                      <X size={12} />
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
