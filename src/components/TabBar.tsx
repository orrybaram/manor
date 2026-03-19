import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import { allPaneIds } from "../store/pane-tree";

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
      className={`session ${isActive ? "session-active" : ""}`}
      onClick={onSelect}
    >
      <span className="session-title">{title}</span>
      {canClose && (
        <span
          className="session-close"
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

  return (
    <div className="session-bar" data-tauri-drag-region>
      <div className="session-bar-sessions">
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
      </div>
      <div className="session-bar-spacer" data-tauri-drag-region />
      <button className="session-add" onClick={addSession}>
        +
      </button>
    </div>
  );
}
