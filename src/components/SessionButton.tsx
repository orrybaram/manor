import { type PointerEvent as ReactPointerEvent } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { X } from "lucide-react";
import { useSessionTitle } from "./useSessionTitle";
import { TabAgentDot } from "./TabAgentDot";
import styles from "./TabBar.module.css";

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
