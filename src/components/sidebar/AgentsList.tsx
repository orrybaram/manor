import { useCallback, useMemo, useRef, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  isContextMenuKey,
  openContextMenuFromKeyboard,
} from "../../lib/keyboard-context-menu";
import Bot from "lucide-react/dist/esm/icons/bot";
import X from "lucide-react/dist/esm/icons/x";
import type { AgentInfo } from "../../electron.d";
import { useAgentStore } from "../../store/agent-store";
import { useAppStore } from "../../store/app-store";
import { useVisibleAgents } from "../../hooks/useVisibleAgents";
import { useAgentPulse } from "../../hooks/useAgentPulse";
import { useProjectStore, MIN_AGENTS_HEIGHT } from "../../store/project-store";
import { useDragOverlayStore } from "../../store/drag-overlay-store";
import { AgentDot } from "../ui/AgentDot/AgentDot";
import { Button } from "../ui/Button/Button";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import { navigateToAgent } from "../../utils/agent-navigation";
import { useAgentDisplay } from "../../hooks/useAgentDisplay";
import { useInlineRename } from "../../hooks/useInlineRename";
import styles from "./AgentsList.module.css";
import menuStyles from "./ProjectItem.module.css";

function AgentRow({ agent, shouldPulse, onClose, onClick, onRename }: {
  agent: AgentInfo;
  shouldPulse: boolean;
  onClose: () => void;
  onClick: () => void;
  onRename: (name: string) => void;
}) {
  const { title, status, reason } = useAgentDisplay(agent);
  const rename = useInlineRename(title, onRename, { emoji: true });
  const rowRef = useRef<HTMLDivElement | null>(null);
  // Set when the row's context menu was opened via the keyboard, so
  // `onCloseAutoFocus` knows to return focus to the row; a mouse-opened menu
  // keeps the rename hook's own restore behaviour (ADR-175).
  const menuOpenedByKeyboard = useRef(false);
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          ref={rowRef}
          role="button"
          tabIndex={0}
          className={styles.agentItem}
          data-testid="sidebar-agent-row"
          data-agent-id={agent.id}
          onClick={() => {
            if (!rename.editing) onClick();
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            rename.start();
          }}
          onKeyDown={(e) => {
            if (rename.editing) return;
            if (isContextMenuKey(e)) {
              e.preventDefault();
              e.stopPropagation();
              menuOpenedByKeyboard.current = true;
              openContextMenuFromKeyboard(e.currentTarget);
              return;
            }
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onClick();
            }
          }}
        >
          {agent.status === "completed" ? (
            <Tooltip label="Completed">
              <span
                className={styles.lifecycleBadge}
                data-testid="agent-lifecycle-badge"
                data-lifecycle="completed"
              />
            </Tooltip>
          ) : (
            <AgentDot
              status={status}
              size="sidebar"
              pulse={shouldPulse}
              reason={reason}
            />
          )}
          {rename.editing ? (
            <>
              <input
                className={menuStyles.workspaceNameInput}
                aria-label="Agent name"
                data-testid="agent-name-input"
                {...rename.inputProps}
              />
              {rename.suggestions}
            </>
          ) : (
            <span className={styles.agentName} title={title} data-testid="agent-name">{title}</span>
          )}
          <Tooltip label="Close agent">
            <Button
              variant="ghost"
              size="sm"
              className={styles.agentClose}
              aria-label="Close agent"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
            >
              <X size={12} />
            </Button>
          </Tooltip>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className={menuStyles.contextMenu}
          onCloseAutoFocus={(e) => {
            rename.menuContentProps.onCloseAutoFocus(e);
            if (e.defaultPrevented) return;
            if (menuOpenedByKeyboard.current) {
              e.preventDefault();
              rowRef.current?.focus();
            }
            menuOpenedByKeyboard.current = false;
          }}
        >
          <ContextMenu.Item
            className={menuStyles.contextMenuItem}
            onSelect={() => rename.start()}
          >
            Rename Agent
          </ContextMenu.Item>
          <ContextMenu.Separator className={menuStyles.contextMenuSeparator} />
          <ContextMenu.Item
            className={`${menuStyles.contextMenuItem} ${menuStyles.contextMenuItemDanger}`}
            onSelect={onClose}
          >
            Close Agent
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

type AgentsListProps = {
  onShowAll?: () => void;
  /**
   * Sized by its content, without the drag-to-resize handle: the collapsed
   * rail's Agents popover (ADR-195), which scrolls on its own.
   */
  fitContent?: boolean;
  /** Called after a row navigates to its agent's pane. */
  onAgentSelect?: () => void;
};

export function AgentsList(props: AgentsListProps) {
  const { onShowAll, fitContent = false, onAgentSelect } = props;

  const agentsHeight = useProjectStore((s) => s.agentsHeight);
  const setAgentsHeight = useProjectStore((s) => s.setAgentsHeight);
  const [isResizing, setIsResizing] = useState(false);
  const startY = useRef(0);
  const startHeight = useRef(0);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      useDragOverlayStore.getState().incrementDragCount();
      startY.current = e.clientY;
      startHeight.current = agentsHeight;

      const onMouseMove = (ev: MouseEvent) => {
        const delta = startY.current - ev.clientY;
        setAgentsHeight(
          Math.max(MIN_AGENTS_HEIGHT, startHeight.current + delta),
        );
      };

      const cleanup = () => {
        useDragOverlayStore.getState().decrementDragCount();
        setIsResizing(false);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", cleanup);
        window.removeEventListener("blur", cleanup);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", cleanup);
      window.addEventListener("blur", cleanup);
    },
    [agentsHeight, setAgentsHeight],
  );

  const visibleAgents = useVisibleAgents();
  const shouldPulse = useAgentPulse();

  // Group agents by projectName
  const groups = useMemo(() => {
    const map = new Map<string, AgentInfo[]>();
    for (const agent of visibleAgents) {
      const key = agent.projectName;
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
      {!fitContent && (
        <div
          className={`${styles.agentsResizeHandle} ${isResizing ? styles.agentsResizeHandleActive : ""}`}
          onMouseDown={handleResizeStart}
          data-testid="sidebar-agents-resize-handle"
        />
      )}
      <div className={styles.sectionHeader}>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <Bot size={12} />
          Agents
        </span>
        {onShowAll && (
          <button
            className={styles.action}
            onClick={onShowAll}
            title="View all agents"
            data-testid="sidebar-agents-view-all"
            style={{ fontSize: 10, opacity: 0.6 }}
          >
            View All
          </button>
        )}
      </div>
      <div className={styles.agentGroups} style={fitContent ? undefined : { height: agentsHeight }}>
        {Array.from(groups.entries()).map(([projectName, groupAgents]) => (
          <div key={projectName} className={styles.agentGroup}>
            <div className={styles.agentGroupHeader}>{projectName}</div>
            {groupAgents.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                shouldPulse={shouldPulse(agent)}
                onClick={() => {
                  navigateToAgent(agent);
                  onAgentSelect?.();
                }}
                onRename={(name) =>
                  useAgentStore.getState().renameAgent(agent.id, name)
                }
                onClose={() => {
                  if (agent.paneId) {
                    useAppStore.getState().closePaneById(agent.paneId);
                  }
                  useAgentStore.getState().removeAgent(agent.id);
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
