import { useState, useMemo } from "react";
import { ChevronRight, ListChecks } from "lucide-react";
import type { AgentStatus, TaskInfo, TaskStatus } from "../electron.d";
import { useTaskStore } from "../store/task-store";
import { useProjectStore } from "../store/project-store";
import { useAppStore } from "../store/app-store";
import { AgentDot } from "./AgentDot";
import { useDebouncedAgentStatus } from "./useDebouncedAgentStatus";
import { allPaneIds } from "../store/pane-tree";
import styles from "./Sidebar.module.css";

const STATUS_LABEL: Record<string, string> = {
  thinking: "Thinking",
  working: "Working",
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

function navigateToTask(task: TaskInfo) {
  const { selectProject, setProjectExpanded, selectWorkspace, projects } =
    useProjectStore.getState();
  const { setActiveWorkspace, selectSession, focusPane, workspaceSessions } =
    useAppStore.getState();

  // Find the project by projectId
  const projectIndex = projects.findIndex((p) => p.id === task.projectId);
  if (projectIndex < 0) return;
  const project = projects[projectIndex];

  // Find the workspace index by workspacePath
  const workspaceIndex = project.workspaces.findIndex(
    (ws) => ws.path === task.workspacePath,
  );
  if (workspaceIndex < 0) return;

  // Find the session containing task.paneId
  let sessionId: string | null = null;
  if (task.paneId && task.workspacePath) {
    const wsSessions = workspaceSessions[task.workspacePath];
    if (wsSessions) {
      for (const session of wsSessions.sessions) {
        if (allPaneIds(session.rootNode).includes(task.paneId)) {
          sessionId = session.id;
          break;
        }
      }
    }
  }

  selectProject(projectIndex);
  setProjectExpanded(project.id);
  selectWorkspace(project.id, workspaceIndex);
  if (task.workspacePath) {
    setActiveWorkspace(task.workspacePath);
  }
  if (sessionId) {
    selectSession(sessionId);
  }
  if (task.paneId) {
    focusPane(task.paneId);
  }
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
          {visibleTasks.length > 0 && (
            <span className={styles.portCount}>{visibleTasks.length}</span>
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
                    {agentStatus && <AgentItemLabel status={agentStatus} />}
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
