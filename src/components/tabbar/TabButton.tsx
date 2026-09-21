import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import Globe from "lucide-react/dist/esm/icons/globe";
import GitCompareArrows from "lucide-react/dist/esm/icons/git-compare-arrows";
import Volume2 from "lucide-react/dist/esm/icons/volume-2";
import VolumeX from "lucide-react/dist/esm/icons/volume-x";
import X from "lucide-react/dist/esm/icons/x";
import { Button } from "../ui/Button/Button";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import { useShallow } from "zustand/react/shallow";
import {
  useAppStore,
  selectActivePanelId,
  selectFocusedPaneId,
} from "../../store/app-store";
import {
  detachTabToNewWindow,
  hasOwnClaim,
  returnToPrimaryWindow,
} from "../../lib/detach";
import { useKeybinding } from "../../store/keybindings-store";
import { formatCombo } from "../../lib/keybindings";
import { useTabTitle } from "../../hooks/useTabTitle";
import {
  isContextMenuKey,
  openContextMenuFromKeyboard,
} from "../../lib/keyboard-context-menu";
import { TabAgentDot } from "./TabAgentDot";
import { isWebApp } from "../../lib/platform";
import styles from "./TabBar/TabBar.module.css";

/** The tab bar's own tabs, in DOM order, within the tab holding `from`. */
function allTabs(from: HTMLElement): HTMLElement[] {
  const root = from.closest<HTMLElement>('[role="tablist"]');
  if (!root) return [from];
  return Array.from(root.querySelectorAll<HTMLElement>('[role="tab"]'));
}

function focusAdjacentTab(from: HTMLElement, delta: 1 | -1): void {
  const tabs = allTabs(from);
  const index = tabs.indexOf(from);
  if (index < 0) return;
  const next = tabs[(index + delta + tabs.length) % tabs.length];
  next?.focus();
}

function focusEdgeTab(from: HTMLElement, edge: "first" | "last"): void {
  const tabs = allTabs(from);
  (edge === "first" ? tabs[0] : tabs[tabs.length - 1])?.focus();
}

/**
 * Keyboard handling for a tab (ADR-175). ←/→ move focus between tabs without
 * selecting; Home/End jump to the ends; Enter/Space select, same as a click.
 * Only runs when the event targets the tab itself — a nested close or mute
 * `Button` handles its own keys (Enter/Space already trigger a native click).
 */
function handleTabKeyDown(
  e: ReactKeyboardEvent<HTMLDivElement>,
  actions: {
    select: () => void;
    /** Shift+F10 / ContextMenu key / ⌘. — wired by ticket 5 (ADR-175). */
    openMenu?: (tab: HTMLElement) => void;
  },
): void {
  if (e.target !== e.currentTarget) return;

  if (isContextMenuKey(e)) {
    if (!actions.openMenu) return;
    e.preventDefault();
    e.stopPropagation();
    actions.openMenu(e.currentTarget);
    return;
  }

  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key) {
    case "Enter":
    case " ":
      // Space would otherwise scroll the tab bar.
      e.preventDefault();
      actions.select();
      break;
    case "ArrowLeft":
      e.preventDefault();
      focusAdjacentTab(e.currentTarget, -1);
      break;
    case "ArrowRight":
      e.preventDefault();
      focusAdjacentTab(e.currentTarget, 1);
      break;
    case "Home":
      e.preventDefault();
      focusEdgeTab(e.currentTarget, "first");
      break;
    case "End":
      e.preventDefault();
      focusEdgeTab(e.currentTarget, "last");
      break;
  }
}

/** Right-aligned keyboard-shortcut hint for a context-menu item. */
function MenuShortcut({ commandId }: { commandId: string }) {
  const combo = useKeybinding(commandId);
  if (!combo) return null;
  return <span className={styles.contextMenuShortcut}>{formatCombo(combo)}</span>;
}

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
  draggable?: boolean;
  onSelect: () => void;
  onClose: () => void;
  onTogglePin: () => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDrag?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  buttonRef: (el: HTMLDivElement | null) => void;
};

export function TabButton(props: TabButtonProps) {
  const { tabId, isActive, isPinned, canClose, isDragging, isDropTarget, draggable, onSelect, onClose, onTogglePin, onDragStart, onDrag, onDragEnd, buttonRef } = props;

  const title = useTabTitle(tabId);
  const { contentType, favicon, audioPlaying, audioMuted, focusedPaneId } = useAppStore(useShallow((s) => {
    const wsPath = s.activeWorkspacePath;
    if (!wsPath) return { contentType: undefined, favicon: undefined, audioPlaying: false, audioMuted: false, focusedPaneId: undefined };
    const layout = s.workspaceLayouts[wsPath];
    if (!layout) return { contentType: undefined, favicon: undefined, audioPlaying: false, audioMuted: false, focusedPaneId: undefined };
    const paneId = selectFocusedPaneId(s, tabId);
    if (paneId) return {
      contentType: s.paneContentType[paneId] as string | undefined,
      favicon: s.paneFavicon[paneId] as string | undefined,
      audioPlaying: !!s.paneAudioPlaying[paneId],
      audioMuted: !!s.paneAudioMuted[paneId],
      focusedPaneId: paneId,
    };
    return { contentType: undefined, favicon: undefined, audioPlaying: false, audioMuted: false, focusedPaneId: undefined };
  }));
  const { hasOtherClosableTabs, hasClosableTabsToRight } = useAppStore(useShallow((s) => {
    const wsPath = s.activeWorkspacePath;
    const empty = { hasOtherClosableTabs: false, hasClosableTabsToRight: false };
    if (!wsPath) return empty;
    const layout = s.workspaceLayouts[wsPath];
    if (!layout) return empty;
    for (const panel of Object.values(layout.panels)) {
      const idx = panel.tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) continue;
      const pinned = new Set(panel.pinnedTabIds);
      const hasOther = panel.tabs.some(
        (t) => t.id !== tabId && !pinned.has(t.id),
      );
      const hasRight = panel.tabs
        .slice(idx + 1)
        .some((t) => !pinned.has(t.id));
      return { hasOtherClosableTabs: hasOther, hasClosableTabsToRight: hasRight };
    }
    return empty;
  }));
  const panelCount = useAppStore((s) => {
    const wsPath = s.activeWorkspacePath;
    if (!wsPath) return 1;
    const layout = s.workspaceLayouts[wsPath];
    if (!layout) return 1;
    return Object.keys(layout.panels).length;
  });
  const [faviconError, setFaviconError] = useState(false);
  const isBrowser = contentType === "browser";
  const isDiff = contentType === "diff";
  const contentTypeClass = isDiff ? styles.tabDiff : isBrowser ? styles.tabBrowser : styles.tabTerminal;
  // Set when the context menu was opened via `openMenu` (keyboard), so
  // `onCloseAutoFocus` knows to return focus to the tab; a mouse-opened menu
  // keeps Radix's own default (don't steal focus after a click).
  const openedByKeyboard = useRef(false);
  const tabElRef = useRef<HTMLDivElement | null>(null);
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          ref={(el) => {
            tabElRef.current = el;
            buttonRef(el);
          }}
          className={`${styles.tab} ${contentTypeClass} ${isActive ? styles.tabActive : ""} ${isDragging ? styles.tabDragging : ""} ${isPinned ? styles.tabPinned : ""} ${isDropTarget ? styles.tabDropTarget : ""}`}
          onClick={onSelect}
          onKeyDown={(e) =>
            handleTabKeyDown(e, {
              select: onSelect,
              openMenu: (tab) => {
                openedByKeyboard.current = true;
                openContextMenuFromKeyboard(tab);
              },
            })
          }
          draggable={draggable}
          onDragStart={onDragStart}
          onDrag={onDrag}
          onDragEnd={onDragEnd}
          data-testid="tab"
          data-tab-id={tabId}
          role="tab"
          aria-selected={isActive}
          tabIndex={isActive ? 0 : -1}
        >
          <TabAgentDot tabId={tabId} />
          {isDiff && <GitCompareArrows size={12} className={styles.tabIcon} />}
          {isBrowser && (favicon && !faviconError ? (
            <img
              src={favicon}
              width={12}
              height={12}
              className={styles.tabIcon}
              onError={() => setFaviconError(true)}
            />
          ) : (
            <Globe size={12} className={styles.tabIcon} />
          ))}
          <span className={styles.tabTitle} data-testid="tab-title">
            {isPinned ? shortenTitle(title) : title}
          </span>
          {(audioPlaying || audioMuted) && (
            <Tooltip label={audioMuted ? "Unmute Tab" : "Mute Tab"}>
              <Button
                variant="ghost"
                size="sm"
                className={styles.tabAudio}
                aria-label={audioMuted ? "Unmute tab" : "Mute tab"}
                tabIndex={isActive ? 0 : -1}
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
              </Button>
            </Tooltip>
          )}
          {canClose && !isPinned && (
            <Tooltip label="Close Tab">
              <Button
                variant="ghost"
                size="sm"
                className={styles.tabClose}
                aria-label="Close tab"
                data-testid="tab-close"
                tabIndex={isActive ? 0 : -1}
                onPointerDown={(e) => {
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose();
                }}
              >
                <X size={12} />
              </Button>
            </Tooltip>
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className={styles.contextMenu}
          onCloseAutoFocus={(e) => {
            if (openedByKeyboard.current) {
              e.preventDefault();
              tabElRef.current?.focus();
            }
            openedByKeyboard.current = false;
          }}
        >
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
                const currentIdx = panelIds.indexOf(
                  selectActivePanelId(state) ?? "",
                );
                const nextPanelId = panelIds[(currentIdx + 1) % panelIds.length];
                state.moveTabToPanel(tabId, nextPanelId);
              }}
            >
              Move Tab to Next Panel
            </ContextMenu.Item>
          )}
          {/* A detached window's one tab offers no "new window": popping it
              out again would leave this window holding nothing, which closes
              it — a no-op with extra steps. `window.detachTab` has no browser
              meaning either (ADR-178) — removed there, not disabled. */}
          {!isWebApp() && !hasOwnClaim() && (
            <ContextMenu.Item
              className={styles.contextMenuItem}
              onSelect={() => void detachTabToNewWindow(tabId)}
            >
              Move to New Window
            </ContextMenu.Item>
          )}
          {hasOwnClaim() && (
            <ContextMenu.Item
              className={styles.contextMenuItem}
              /* Closing is the whole operation: the claim dies with the
                 window and the tab is already in the primary (ADR-179 D4). */
              onSelect={() => returnToPrimaryWindow()}
            >
              Move Back to Main Window
            </ContextMenu.Item>
          )}
          {canClose && (
            <>
              <ContextMenu.Separator className={styles.contextMenuSeparator} />
              <ContextMenu.Item
                className={styles.contextMenuItem}
                onSelect={onClose}
              >
                Close Tab
                <MenuShortcut commandId="close-tab" />
              </ContextMenu.Item>
              {hasOtherClosableTabs && (
                <ContextMenu.Item
                  className={styles.contextMenuItem}
                  onSelect={() => {
                    useAppStore.getState().closeOtherTabs(tabId);
                  }}
                >
                  Close Other Tabs
                </ContextMenu.Item>
              )}
              {hasClosableTabsToRight && (
                <ContextMenu.Item
                  className={styles.contextMenuItem}
                  onSelect={() => {
                    useAppStore.getState().closeTabsToRight(tabId);
                  }}
                >
                  Close Tabs to the Right
                </ContextMenu.Item>
              )}
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
