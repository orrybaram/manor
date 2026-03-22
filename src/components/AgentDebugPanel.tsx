import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import { allPaneIds } from "../store/pane-tree";
import type { AgentState } from "../electron.d";
import { AgentDot } from "./AgentDot";
import styles from "./AgentDebugPanel.module.css";

function formatElapsed(since: number): string {
  const ms = Date.now() - since;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function PaneRow({ paneId, agent }: { paneId: string; agent: AgentState }) {
  return (
    <div className={styles.row}>
      <span className={styles.paneId}>{paneId.slice(0, 12)}</span>
      <AgentDot status={agent.status} size="debug" />
      <span className={styles.status}>{agent.status}</span>
      <span className={styles.kind}>{agent.kind ?? "—"}</span>
      <span className={styles.elapsed}>{formatElapsed(agent.since)}</span>
      {agent.title && (
        <span className={styles.title} title={agent.title}>
          {agent.title}
        </span>
      )}
    </div>
  );
}

export function AgentDebugPanel() {
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);
  const ws = useAppStore(selectActiveWorkspace);

  // Get all pane IDs for the active workspace
  const activePaneIds = new Set<string>();
  if (ws) {
    for (const session of ws.sessions) {
      for (const id of allPaneIds(session.rootNode)) {
        activePaneIds.add(id);
      }
    }
  }

  // All panes with agent status
  const entries = Object.entries(paneAgentStatus);
  // Also show active panes that have no agent status (idle)
  const idlePanes = [...activePaneIds].filter(
    (id) => !paneAgentStatus[id],
  );

  return (
    <div className={styles.panel}>
      <div className={styles.header}>Agent Status Debug</div>
      <div className={styles.body}>
        {entries.length === 0 && idlePanes.length === 0 && (
          <div className={styles.empty}>No panes</div>
        )}
        {entries.map(([paneId, agent]) => (
          <PaneRow key={paneId} paneId={paneId} agent={agent} />
        ))}
        {idlePanes.map((paneId) => (
          <div key={paneId} className={styles.row}>
            <span className={styles.paneId}>{paneId.slice(0, 12)}</span>
            <AgentDot status="idle" size="debug" />
            <span className={styles.status}>idle</span>
            <span className={styles.kind}>—</span>
            <span className={styles.elapsed}>—</span>
          </div>
        ))}
      </div>
    </div>
  );
}
