import { type PointerEvent as ReactPointerEvent } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import Globe from "lucide-react/dist/esm/icons/globe";
import X from "lucide-react/dist/esm/icons/x";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import { useAppStore, selectActiveWorkspace } from "../../store/app-store";
import { useSessionTitle } from "../../hooks/useSessionTitle";
import { TabAgentDot } from "./TabAgentDot";
import styles from "./TabBar/TabBar.module.css";

/**
 * Shorten a title to fit in a pinned tab (~40px).
 * Truncates to 5 characters.
 */
function shortenTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return "";
  return trimmed.length <= 5 ? trimmed : trimmed.slice(0, 5);
}

type SessionButtonProps = {
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
};

export function SessionButton(props: SessionButtonProps) {
  const { sessionId, isActive, isPinned, canClose, isDragging, onSelect, onClose, onTogglePin, onPointerDown, style, buttonRef } = props;

  const title = useSessionTitle(sessionId);
  const isBrowser = useAppStore((s) => {
    const ws = selectActiveWorkspace(s);
    const session = ws?.sessions.find((t) => t.id === sessionId);
    const paneId = session?.focusedPaneId;
    return paneId ? s.paneContentType[paneId] === "browser" : false;
  });
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
          {isBrowser && <Globe size={12} className={styles.sessionIcon} />}
          <span className={styles.sessionTitle}>
            {isPinned ? shortenTitle(title) : title}
          </span>
          {canClose && !isPinned && (
            <Tooltip label="Close Tab">
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
            </Tooltip>
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
