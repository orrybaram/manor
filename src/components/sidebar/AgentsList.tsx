import { useMemo } from "react";
import ListChecks from "lucide-react/dist/esm/icons/list-checks";
import X from "lucide-react/dist/esm/icons/x";
import type { AgentInfo } from "../../electron.d";
import { useAgentStore } from "../../store/agent-store";
import { useAppStore, selectVisiblePaneIds } from "../../store/app-store";
import { AgentDot } from "../ui/AgentDot/AgentDot";
import { allPaneIds } from "../../store/pane-tree";
import { navigateToAgent } from "../../utils/agent-navigation";
import { useAgentDisplay } from "../../hooks/useAgentDisplay";
import styles from "./AgentsList.module.css";

function AgentRow({ agent, shouldPulse, onClose, onClick }: {
  agent: AgentInfo;
  shouldPulse: boolean;
  onClose: () => void;
  onClick: () => void;
}) {
  const { title, status } = useAgentDisplay(agent);
  return (
    <button className={styles.agentItem} onClick={onClick}>
      <AgentDot status={status} size="sidebar" pulse={shouldPulse} />
      <span className={styles.agentName}>{title}</span>
      <span className={styles.agentClose} onClick={(e) => { e.stopPropagation(); onClose(); }} title="Close agent">
        <X size={12} />
      </span>
    </button>
  );
}

type AgentsListProps = {
  onShowAll?: () => void;
};

export function AgentsList(props: AgentsListProps) {
  const { onShowAll } = props;

  const { agents, unseenRespondedAgentIds, unseenInputAgentIds } = useAgentStore();
  const workspaceLayouts = useAppStore((s) => s.workspaceLayouts);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);

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

  // Panes the user can currently see. Shares `selectVisiblePaneIds` with the
  // read-state sweep in the agent store, so the sidebar dot and main's unseen
  // flags cannot disagree about what counts as on screen (issue #142).
  const visiblePaneIds = useMemo(
    () => selectVisiblePaneIds({ activeWorkspacePath, workspaceLayouts }),
    [activeWorkspacePath, workspaceLayouts],
  );

  // Show active agents only while they still own a pane; show completed/error/abandoned
  // only if their pane is still active. Orphaned active records (paneId null) are
  // hidden because they have no pane to navigate to.
  //
  // Pagination note (ADR-136): the agent store loads `agents:getActive` (all active)
  // plus the first page of `agents:getAll` (most recent N). A non-active agent whose
  // paneId is still in the current layout is by construction recent — its pane
  // hasn't been closed yet — and is therefore expected to be inside the first
  // page. If a user closes the modal before scrolling far enough to load older
  // agents, the visible set here is unaffected.
  const visibleAgents = useMemo(
    () =>
      agents.filter(
        (t) =>
          (t.status === "active" && t.paneId != null) ||
          (t.paneId != null && activePaneIds.has(t.paneId)),
      ),
    [agents, activePaneIds],
  );

  // Group agents by projectName
  const groups = useMemo(() => {
    const map = new Map<string, AgentInfo[]>();
    for (const agent of visibleAgents) {
      const key = agent.projectName ?? "Unknown";
      let list = map.get(key);
      if (!list) {
        list = [];
        map.set(key, list);
      }
      list.push(agent);
    }
    return map;
  }, [visibleAgents]);

  if (visibleAgents.length === 0) return null;

  return (
    <div className={styles.agentsSection}>
      <div className={styles.sectionHeader}>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <ListChecks size={12} />
          Agents
        </span>
        {onShowAll && (
          <button
            className={styles.action}
            onClick={onShowAll}
            title="View all agents"
            style={{ fontSize: 10, opacity: 0.6 }}
          >
            View All
          </button>
        )}
      </div>
      <div className={styles.agentGroups}>
        {Array.from(groups.entries()).map(([projectName, groupAgents]) => (
          <div key={projectName} className={styles.agentGroup}>
            <div className={styles.agentGroupHeader}>{projectName}</div>
            {groupAgents.map((agent) => {
              const isVisible =
                agent.paneId != null && visiblePaneIds.has(agent.paneId);
              // Pulse predicate (ADR-136 §"Change 3"): main owns the unseen
              // flags; pulse iff the current status matches an unseen axis.
              const shouldPulse =
                !isVisible &&
                ((agent.lastAgentStatus === "responded" &&
                  unseenRespondedAgentIds.has(agent.id)) ||
                  (agent.lastAgentStatus === "requires_input" &&
                    unseenInputAgentIds.has(agent.id)));
              return (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  shouldPulse={shouldPulse}
                  onClick={() => navigateToAgent(agent)}
                  onClose={() => {
                    if (agent.paneId) {
                      useAppStore.getState().closePaneById(agent.paneId);
                    }
                    useAgentStore.getState().removeAgent(agent.id);
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
