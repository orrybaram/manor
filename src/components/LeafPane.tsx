import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import { TerminalPane } from "./TerminalPane";
import { AgentDot } from "./AgentDot";
import styles from "./PaneLayout.module.css";

export function LeafPane({ paneId, workspacePath }: { paneId: string; workspacePath?: string }) {
  const focusedPaneId = useAppStore((s) => {
    const ws = selectActiveWorkspace(s);
    const session = ws?.sessions.find((t) => t.id === ws.selectedSessionId);
    return session?.focusedPaneId;
  });
  const paneTitle = useAppStore((s) => s.paneTitle[paneId]);
  const paneCwd = useAppStore((s) => s.paneCwd[paneId]);
  const agentStatus = useAppStore((s) => s.paneAgentStatus[paneId]);
  const focusPane = useAppStore((s) => s.focusPane);
  const splitPane = useAppStore((s) => s.splitPane);
  const closePane = useAppStore((s) => s.closePane);
  const isFocused = focusedPaneId === paneId;

  let title = paneTitle || (paneCwd ? paneCwd.split("/").pop() : "") || "Terminal";
  // Strip "user@host:" prefix from default shell titles
  title = title.replace(/^.+@.+:/, "");

  const handleSplit = (e: React.MouseEvent) => {
    e.stopPropagation();
    focusPane(paneId);
    splitPane("horizontal");
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    focusPane(paneId);
    closePane();
  };

  return (
    <div
      className={`${styles.leaf} ${isFocused ? styles.leafFocused : ""}`}
      onMouseDown={() => focusPane(paneId)}
    >
      <div className={`${styles.paneStatusBar} ${isFocused ? styles.paneStatusBarFocused : ""}`}>
          <AgentDot status={agentStatus?.status} size="pane" />
          <span className={styles.paneStatusTitle}>{title}</span>
          <div className={styles.paneStatusActions}>
            <button
              className={styles.paneStatusBtn}
              onClick={handleSplit}
              title="Split pane"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <rect x="1" y="1" width="14" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
                <line x1="8" y1="1.5" x2="8" y2="14.5" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
            <button
              className={styles.paneStatusBtn}
              onClick={handleClose}
              title="Close pane"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <line x1="3" y1="3" x2="13" y2="13" stroke="currentColor" strokeWidth="1.5" />
                <line x1="13" y1="3" x2="3" y2="13" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
          </div>
        </div>
      <div className={styles.leafTerminal}>
        <TerminalPane paneId={paneId} cwd={workspacePath} />
      </div>
    </div>
  );
}
