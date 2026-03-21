import { type PointerEvent as ReactPointerEvent } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { X } from "lucide-react";
import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import type { AgentStatus } from "../electron.d";
import { AgentDot } from "./AgentDot";
import styles from "./TabBar.module.css";

function useSessionTitle(sessionId: string): string {
  // First, resolve which pane ID we care about
  const focusedPaneId = useAppStore((s) => {
    const ws = selectActiveWorkspace(s);
    const session = ws?.sessions.find((t) => t.id === sessionId);
    return session?.focusedPaneId ?? null;
  });

  // Then subscribe narrowly to just that pane's title and CWD
  const title = useAppStore((s) => focusedPaneId ? s.paneTitle[focusedPaneId] ?? null : null);
  const cwd = useAppStore((s) => focusedPaneId ? s.paneCwd[focusedPaneId] ?? null : null);

  // Prefer terminal title (from OSC sequences — reflects the running process)
  // But if it's just a default shell "user@host:path" title, extract the project name
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
  if (cwd) {
    const parts = cwd.split("/");
    return parts[parts.length - 1] || parts[parts.length - 2] || cwd;
  }

  return "Terminal";
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

/**
 * Shorten a title to fit in a pinned tab (~50px).
 * Strategy: first letter of each word for multi-word titles,
 * or first 3 chars for single words.
 */
function shortenTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return "";

  // Split on common separators: spaces, hyphens, underscores, camelCase
  const words = trimmed
    .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase → camel Case
    .split(/[\s\-_]+/)
    .filter(Boolean);

  if (words.length > 1) {
    // Use first letter of each word (up to 4)
    return words
      .slice(0, 4)
      .map((w) => w[0].toUpperCase())
      .join("");
  }

  // Single word: take first 3 chars
  return trimmed.length <= 3 ? trimmed : trimmed.slice(0, 3);
}

export function SessionButton({
  sessionId,
  isActive,
  isPinned,
  canClose,
  isDragging,
  onSelect,
  onClose,
  onTogglePin,
  onPointerDown,
  style,
  buttonRef,
}: {
  sessionId: string;
  isActive: boolean;
  isPinned: boolean;
  canClose: boolean;
  isDragging: boolean;
  onSelect: () => void;
  onClose: () => void;
  onTogglePin: () => void;
  onPointerDown?: (e: ReactPointerEvent) => void;
  style: React.CSSProperties;
  buttonRef: (el: HTMLDivElement | null) => void;
}) {
  const title = useSessionTitle(sessionId);
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          ref={buttonRef}
          className={`${styles.session} ${isActive ? styles.sessionActive : ""} ${isDragging ? styles.sessionDragging : ""} ${isPinned ? styles.sessionPinned : ""}`}
          onClick={onSelect}
          onPointerDown={onPointerDown}
          style={style}
        >
          <TabAgentDot sessionId={sessionId} />
          <span className={styles.sessionTitle}>{isPinned ? shortenTitle(title) : title}</span>
          {canClose && !isPinned && (
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
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={styles.contextMenu}>
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={onTogglePin}
          >
            {isPinned ? "Unpin Tab" : "Pin Tab"}
          </ContextMenu.Item>
          {canClose && (
            <>
              <ContextMenu.Separator className={styles.contextMenuSeparator} />
              <ContextMenu.Item
                className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
                onSelect={onClose}
              >
                Close Tab
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
