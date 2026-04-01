import { useMemo } from "react";
import ListChecks from "lucide-react/dist/esm/icons/list-checks";
import X from "lucide-react/dist/esm/icons/x";
import type { AgentStatus, TaskInfo, TaskStatus } from "../../electron.d";
import { useTaskStore } from "../../store/task-store";
import { useAppStore } from "../../store/app-store";
import { AgentDot } from "../ui/AgentDot/AgentDot";
import { allPaneIds } from "../../store/pane-tree";
import { navigateToTask } from "../../utils/task-navigation";
import styles from "./TasksList.module.css";

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

type TasksListProps = {
  onShowAll?: () => void;
};

export function TasksList(props: TasksListProps) {
  const { onShowAll } = props;

  const { tasks, seenTaskIds } = useTaskStore();
  const workspaceSessions = useAppStore((s) => s.workspaceSessions);

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

  // Collect visible pane IDs in the active session (panes the user can currently see)
  const visiblePaneIds = useMemo(() => {
    const ids = new Set<string>();
    for (const ws of Object.values(workspaceSessions)) {
      const activeSession = ws.sessions.find(
        (s) => s.id === ws.selectedSessionId,
      );
      if (activeSession) {
        for (const id of allPaneIds(activeSession.rootNode)) {
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

  if (visibleTasks.length === 0) return null;

  return (
    <div className={styles.tasksSection}>
      <div className={styles.sectionHeader}>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <ListChecks size={12} />
          Tasks
        </span>
        {onShowAll && (
          <button
            className={styles.action}
            onClick={onShowAll}
            title="View all tasks"
            style={{ fontSize: 10, opacity: 0.6 }}
          >
            View All
          </button>
        )}
      </div>
      <div className={styles.taskGroups}>
        {Array.from(groups.entries()).map(([projectName, groupTasks]) => (
          <div key={projectName} className={styles.taskGroup}>
            <div className={styles.taskGroupHeader}>{projectName}</div>
            {groupTasks.map((task) => {
              const agentStatus = taskAgentStatus(task);
              const isVisible =
                task.paneId != null && visiblePaneIds.has(task.paneId);
              const shouldPulse = !isVisible && !seenTaskIds.has(task.id);
              return (
                <button
                  key={task.id}
                  className={styles.agentItem}
                  onClick={() => navigateToTask(task)}
                >
                  <AgentDot
                    status={agentStatus}
                    size="sidebar"
                    pulse={shouldPulse}
                  />
                  <span className={styles.agentName}>
                    {task.name || "Agent"}
                  </span>
                  <span
                    className={styles.taskClose}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (task.paneId) {
                        useAppStore.getState().closePaneById(task.paneId);
                      }
                      useTaskStore.getState().removeTask(task.id);
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
    </div>
  );
}
