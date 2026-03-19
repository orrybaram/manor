import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import { allPaneIds } from "../store/pane-tree";
import styles from "./TabBar.module.css";

function useSessionTitle(sessionId: string): string {
  const session = useAppStore((s) =>
    selectActiveWorkspace(s)?.sessions.find((t) => t.id === sessionId)
  );
  const paneCwd = useAppStore((s) => s.paneCwd);
  if (!session) return "Terminal";
  // Show CWD of the focused pane, or fall back to session title
  const cwd = paneCwd[session.focusedPaneId];
  if (cwd) {
    const parts = cwd.split("/");
    return parts[parts.length - 1] || parts[parts.length - 2] || cwd;
  }
  // Try any pane in the session
  const ids = allPaneIds(session.rootNode);
  for (const id of ids) {
    const c = paneCwd[id];
    if (c) {
      const parts = c.split("/");
      return parts[parts.length - 1] || parts[parts.length - 2] || c;
    }
  }
  return session.title;
}

function SessionButton({
  sessionId,
  isActive,
  canClose,
  onSelect,
  onClose,
}: {
  sessionId: string;
  isActive: boolean;
  canClose: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const title = useSessionTitle(sessionId);
  return (
    <button
      className={`${styles.session} ${isActive ? styles.sessionActive : ""}`}
      onClick={onSelect}
    >
      <span className={styles.sessionTitle}>{title}</span>
      {canClose && (
        <span
          className={styles.sessionClose}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          ×
        </span>
      )}
    </button>
  );
}

export function TabBar() {
  const ws = useAppStore(selectActiveWorkspace);
  const sessions = ws?.sessions ?? [];
  const selectedSessionId = ws?.selectedSessionId ?? null;
  const selectSession = useAppStore((s) => s.selectSession);
  const addSession = useAppStore((s) => s.addSession);
  const closeSession = useAppStore((s) => s.closeSession);
  const sidebarVisible = useProjectStore((s) => s.sidebarVisible);

  return (
    <div className={`${styles.sessionBar} ${!sidebarVisible ? styles.noSidebar : ""}`}>
      <div className={styles.sessions}>
        {sessions.map((session) => (
          <SessionButton
            key={session.id}
            sessionId={session.id}
            isActive={session.id === selectedSessionId}
            canClose={sessions.length > 1}
            onSelect={() => selectSession(session.id)}
            onClose={() => closeSession(session.id)}
          />
        ))}
        <button className={styles.addButton} onClick={addSession}>
          +
        </button>
      </div>
      <div className={styles.spacer} />
    </div>
  );
}
