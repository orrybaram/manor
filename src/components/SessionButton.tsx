import { type PointerEvent as ReactPointerEvent } from "react";
import { X } from "lucide-react";
import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import { allPaneIds } from "../store/pane-tree";
import type { AgentStatus } from "../electron.d";
import { AgentDot } from "./AgentDot";
import styles from "./TabBar.module.css";

function useSessionTitle(sessionId: string): string {
  const session = useAppStore((s) =>
    selectActiveWorkspace(s)?.sessions.find((t) => t.id === sessionId)
  );
  const paneCwd = useAppStore((s) => s.paneCwd);
  const paneTitle = useAppStore((s) => s.paneTitle);
  if (!session) return "Terminal";

  // Prefer terminal title (from OSC sequences — reflects the running process)
  // But if it's just a default shell "user@host:path" title, extract the project name
  const title = paneTitle[session.focusedPaneId];
  if (title) {
    const cwdMatch = title.match(/^.+@.+:(.+)$/);
    if (cwdMatch) {
      const path = cwdMatch[1];
      const parts = path.replace(/\/+$/, "").split("/");
      return parts[parts.length - 1] || title;
    }
    return title;
  }

  // Fall back to CWD of the focused pane
  const cwd = paneCwd[session.focusedPaneId];
  if (cwd) {
    const parts = cwd.split("/");
    return parts[parts.length - 1] || parts[parts.length - 2] || cwd;
  }
  // Try any pane in the session
  const ids = allPaneIds(session.rootNode);
  for (const id of ids) {
    const t = paneTitle[id];
    if (t) return t;
    const c = paneCwd[id];
    if (c) {
      const parts = c.split("/");
      return parts[parts.length - 1] || parts[parts.length - 2] || c;
    }
  }
  return session.title;
}

const STATUS_PRIORITY: Record<AgentStatus, number> = {
  waiting: 4,
  running: 3,
  error: 2,
  complete: 1,
  idle: 0,
};

function useSessionAgentStatus(sessionId: string): AgentStatus | null {
  return useAppStore((s) => {
    const ws = selectActiveWorkspace(s);
    const session = ws?.sessions.find((t) => t.id === sessionId);
    if (!session) return null;

    const ids = allPaneIds(session.rootNode);
    let best: AgentStatus | null = null;
    let bestPriority = 0;

    for (const id of ids) {
      const agent = s.paneAgentStatus[id];
      if (!agent) continue;
      const p = STATUS_PRIORITY[agent.status] ?? 0;
      if (p > bestPriority) {
        bestPriority = p;
        best = agent.status;
      }
    }

    return best;
  });
}

function TabAgentDot({ sessionId }: { sessionId: string }) {
  const status = useSessionAgentStatus(sessionId);
  return <AgentDot status={status ?? undefined} size="tab" />;
}

export function SessionButton({
  sessionId,
  isActive,
  canClose,
  isDragging,
  onSelect,
  onClose,
  onPointerDown,
  style,
  buttonRef,
}: {
  sessionId: string;
  isActive: boolean;
  canClose: boolean;
  isDragging: boolean;
  onSelect: () => void;
  onClose: () => void;
  onPointerDown: (e: ReactPointerEvent) => void;
  style: React.CSSProperties;
  buttonRef: (el: HTMLDivElement | null) => void;
}) {
  const title = useSessionTitle(sessionId);
  return (
    <div
      ref={buttonRef}
      className={`${styles.session} ${isActive ? styles.sessionActive : ""} ${isDragging ? styles.sessionDragging : ""}`}
      onClick={onSelect}
      onPointerDown={onPointerDown}
      style={style}
    >
      <TabAgentDot sessionId={sessionId} />
      <span className={styles.sessionTitle}>{title}</span>
      {canClose && (
        <span
          className={styles.sessionClose}
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <X size={12} />
        </span>
      )}
    </div>
  );
}
