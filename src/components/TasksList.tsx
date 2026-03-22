import { useState } from "react";
import { ChevronRight, ListChecks } from "lucide-react";
import type { AgentStatus } from "../electron.d";
import { useAllAgents, type GlobalAgent } from "../hooks/useAllAgents";
import { useProjectStore } from "../store/project-store";
import { useAppStore } from "../store/app-store";
import { AgentDot } from "./AgentDot";
import { useDebouncedAgentStatus } from "./useDebouncedAgentStatus";
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

function cleanAgentTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const cleaned = title
    .replace(/[\u2800-\u28FF]/g, "")
    .replace(/[✳✻✽✶✢]/g, "")
    .trim();
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();
  if (lower === "claude code" || lower === "claude" || lower === "opencode" || lower === "codex") {
    return null;
  }
  return cleaned;
}

function navigateToAgent(agent: GlobalAgent) {
  const { selectProject, setProjectExpanded, selectWorkspace } =
    useProjectStore.getState();
  const { setActiveWorkspace, selectSession, focusPane } =
    useAppStore.getState();

  selectProject(agent.projectIndex);
  setProjectExpanded(
    useProjectStore.getState().projects[agent.projectIndex].id,
  );
  selectWorkspace(
    useProjectStore.getState().projects[agent.projectIndex].id,
    agent.workspaceIndex,
  );
  setActiveWorkspace(agent.workspacePath);
  selectSession(agent.sessionId);
  focusPane(agent.paneId);
}

export function TasksList({ onShowAll }: { onShowAll?: () => void }) {
  const agents = useAllAgents();
  const [collapsed, setCollapsed] = useState(false);

  if (agents.length === 0) return null;

  // Group agents by projectName
  const groups = new Map<string, GlobalAgent[]>();
  for (const agent of agents) {
    let list = groups.get(agent.projectName);
    if (!list) {
      list = [];
      groups.set(agent.projectName, list);
    }
    list.push(agent);
  }

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
          <span className={styles.portCount}>{agents.length}</span>
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
      {!collapsed && (
        <div className={styles.taskGroups}>
          {Array.from(groups.entries()).map(([projectName, groupAgents]) => (
            <div key={projectName} className={styles.taskGroup}>
              <div className={styles.taskGroupHeader}>{projectName}</div>
              {groupAgents.map((a) => (
                <button
                  key={a.paneId}
                  className={styles.agentItem}
                  onClick={() => navigateToAgent(a)}
                >
                  <AgentDot status={a.agent.status} size="sidebar" />
                  <span className={styles.agentName}>
                    {cleanAgentTitle(a.agent.title) || a.agent.kind || "Agent"}
                  </span>
                  <AgentItemLabel status={a.agent.status} />
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
