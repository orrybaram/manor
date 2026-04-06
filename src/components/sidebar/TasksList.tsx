import { useMemo } from "react";
import ListChecks from "lucide-react/dist/esm/icons/list-checks";
import X from "lucide-react/dist/esm/icons/x";
import type { TaskInfo } from "../../electron.d";
import { useTaskStore } from "../../store/task-store";
import { useAppStore } from "../../store/app-store";
import { AgentDot } from "../ui/AgentDot/AgentDot";
import { allPaneIds } from "../../store/pane-tree";
import { navigateToTask } from "../../utils/task-navigation";
import { useTaskDisplay } from "../../hooks/useTaskDisplay";
import styles from "./TasksList.module.css";

function TaskRow({ task, shouldPulse, onClose, onClick }: {
  task: TaskInfo;
  shouldPulse: boolean;
  onClose: () => void;
  onClick: () => void;
}) {
  const { title, status } = useTaskDisplay(task);
  return (
    <button className={styles.agentItem} onClick={onClick}>
      <AgentDot status={status} size="sidebar" pulse={shouldPulse} />
      <span className={styles.agentName}>{title}</span>
      <span className={styles.taskClose} onClick={(e) => { e.stopPropagation(); onClose(); }} title="Close task">
        <X size={12} />
      </span>
    </button>
  );
}

type TasksListProps = {
  onShowAll?: () => void;
};

export function TasksList(props: TasksListProps) {
  const { onShowAll } = props;

  const { tasks, seenTaskIds } = useTaskStore();
  const workspaceLayouts = useAppStore((s) => s.workspaceLayouts);

  // Collect all active pane IDs across all workspace layouts
  const activePaneIds = useMemo(() => {
    const ids = new Set<string>();
    for (const layout of Object.values(workspaceLayouts)) {
      for (const panel of Object.values(layout.panels)) {
        for (const tab of panel.tabs) {
          for (const id of allPaneIds(tab.rootNode)) {
            ids.add(id);
          }
        }
      }
    }
    return ids;
  }, [workspaceLayouts]);

  // Collect visible pane IDs in the active tab (panes the user can currently see)
  const visiblePaneIds = useMemo(() => {
    const ids = new Set<string>();
    for (const layout of Object.values(workspaceLayouts)) {
      const panel = layout.panels[layout.activePanelId];
      if (!panel) continue;
      const activeTab = panel.tabs.find(
        (s) => s.id === panel.selectedTabId,
      );
      if (activeTab) {
        for (const id of allPaneIds(activeTab.rootNode)) {
          ids.add(id);
        }
      }
    }
    return ids;
  }, [workspaceLayouts]);

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
              const isVisible =
                task.paneId != null && visiblePaneIds.has(task.paneId);
              const shouldPulse = !isVisible && !seenTaskIds.has(task.id);
              return (
                <TaskRow
                  key={task.id}
                  task={task}
                  shouldPulse={shouldPulse}
                  onClick={() => navigateToTask(task)}
                  onClose={() => {
                    if (task.paneId) {
                      useAppStore.getState().closePaneById(task.paneId);
                    }
                    useTaskStore.getState().removeTask(task.id);
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
