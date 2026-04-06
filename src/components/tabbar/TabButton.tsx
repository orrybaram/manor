import { type PointerEvent as ReactPointerEvent } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import Globe from "lucide-react/dist/esm/icons/globe";
import GitCompareArrows from "lucide-react/dist/esm/icons/git-compare-arrows";
import Volume2 from "lucide-react/dist/esm/icons/volume-2";
import VolumeX from "lucide-react/dist/esm/icons/volume-x";
import X from "lucide-react/dist/esm/icons/x";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../store/app-store";
import { useTabTitle } from "../../hooks/useTabTitle";
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

type TabButtonProps = {
  tabId: string;
  isActive: boolean;
  isPinned: boolean;
  canClose: boolean;
  isDragging: boolean;
  isDropTarget?: boolean;
  onSelect: () => void;
  onClose: () => void;
  onTogglePin: () => void;
  onPointerDown?: (e: ReactPointerEvent) => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  onPointerUp?: (e: ReactPointerEvent) => void;
  style: React.CSSProperties;
  buttonRef: (el: HTMLDivElement | null) => void;
};

export function TabButton(props: TabButtonProps) {
  const { tabId, isActive, isPinned, canClose, isDragging, isDropTarget, onSelect, onClose, onTogglePin, onPointerDown, onPointerEnter, onPointerLeave, onPointerUp, style, buttonRef } = props;

  const title = useTabTitle(tabId);
  const { contentType, favicon, audioPlaying, audioMuted, focusedPaneId } = useAppStore(useShallow((s) => {
    const wsPath = s.activeWorkspacePath;
    if (!wsPath) return { contentType: undefined, favicon: undefined, audioPlaying: false, audioMuted: false, focusedPaneId: undefined };
    const layout = s.workspaceLayouts[wsPath];
    if (!layout) return { contentType: undefined, favicon: undefined, audioPlaying: false, audioMuted: false, focusedPaneId: undefined };
    for (const panel of Object.values(layout.panels)) {
      const tab = panel.tabs.find((t) => t.id === tabId);
      if (tab) return {
        contentType: s.paneContentType[tab.focusedPaneId] as string | undefined,
        favicon: s.paneFavicon[tab.focusedPaneId] as string | undefined,
        audioPlaying: !!s.paneAudioPlaying[tab.focusedPaneId],
        audioMuted: !!s.paneAudioMuted[tab.focusedPaneId],
        focusedPaneId: tab.focusedPaneId,
      };
    }
    return { contentType: undefined, favicon: undefined, audioPlaying: false, audioMuted: false, focusedPaneId: undefined };
  }));
  const panelCount = useAppStore((s) => {
    const wsPath = s.activeWorkspacePath;
    if (!wsPath) return 1;
    const layout = s.workspaceLayouts[wsPath];
    if (!layout) return 1;
    return Object.keys(layout.panels).length;
  });
  const isBrowser = contentType === "browser";
  const isDiff = contentType === "diff";
  const contentTypeClass = isDiff ? styles.tabDiff : isBrowser ? styles.tabBrowser : styles.tabTerminal;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          ref={buttonRef}
          className={`${styles.tab} ${contentTypeClass} ${isActive ? styles.tabActive : ""} ${isDragging ? styles.tabDragging : ""} ${isPinned ? styles.tabPinned : ""} ${isDropTarget ? styles.tabDropTarget : ""}`}
          onClick={onSelect}
          onPointerDown={onPointerDown}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          onPointerUp={onPointerUp}
          style={style}
        >
          <TabAgentDot tabId={tabId} />
          {isDiff && <GitCompareArrows size={12} className={styles.tabIcon} />}
          {isBrowser && (favicon ? (
            <img
              src={favicon}
              width={12}
              height={12}
              className={styles.tabIcon}
              onError={(e) => { (e.target as HTMLImageElement).replaceWith(document.createElement("span")); }}
            />
          ) : (
            <Globe size={12} className={styles.tabIcon} />
          ))}
          <span className={styles.tabTitle}>
            {isPinned ? shortenTitle(title) : title}
          </span>
          {(audioPlaying || audioMuted) && (
            <Tooltip label={audioMuted ? "Unmute Tab" : "Mute Tab"}>
              <span
                className={styles.tabAudio}
                onPointerDown={(e) => {
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (focusedPaneId) {
                    const newMuted = !audioMuted;
                    window.electronAPI.webview.setAudioMuted(focusedPaneId, newMuted);
                    useAppStore.getState().setPaneAudioMuted(focusedPaneId, newMuted);
                  }
                }}
              >
                {audioMuted ? <VolumeX size={12} /> : <Volume2 size={12} />}
              </span>
            </Tooltip>
          )}
          {canClose && !isPinned && (
            <Tooltip label="Close Tab">
              <span
                className={styles.tabClose}
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
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={() => {
              useAppStore.getState().duplicateTab(tabId);
            }}
          >
            Duplicate Tab
          </ContextMenu.Item>
          <ContextMenu.Separator className={styles.contextMenuSeparator} />
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={() => {
              const store = useAppStore.getState();
              store.selectTab(tabId);
              store.splitPanel("horizontal");
            }}
          >
            Move to New Panel Right
          </ContextMenu.Item>
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={() => {
              const store = useAppStore.getState();
              store.selectTab(tabId);
              store.splitPanel("vertical");
            }}
          >
            Move to New Panel Down
          </ContextMenu.Item>
          {panelCount > 1 && (
            <ContextMenu.Item
              className={styles.contextMenuItem}
              onSelect={() => {
                const state = useAppStore.getState();
                const wsPath = state.activeWorkspacePath;
                if (!wsPath) return;
                const layout = state.workspaceLayouts[wsPath];
                if (!layout) return;
                const panelIds = Object.keys(layout.panels);
                const currentIdx = panelIds.indexOf(layout.activePanelId);
                const nextPanelId = panelIds[(currentIdx + 1) % panelIds.length];
                state.moveTabToPanel(tabId, nextPanelId);
              }}
            >
              Move Tab to Next Panel
            </ContextMenu.Item>
          )}
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
