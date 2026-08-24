import { useCallback, useMemo, useRef, useState } from "react";
import Plus from "lucide-react/dist/esm/icons/plus";
import Globe from "lucide-react/dist/esm/icons/globe";
import ListTodo from "lucide-react/dist/esm/icons/list-todo";
import * as Popover from "@radix-ui/react-popover";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import { useAppStore, selectActiveWorkspace } from "../../../store/app-store";
import { useProjectStore } from "../../../store/project-store";
import { usePaneDrag } from "../../workspace-panes/PaneDragContext";
import { trackHandoff } from "../../../lib/window-handoff";
import { TabButton } from "../TabButton";
import styles from "./TabBar.module.css";

const TAB_GAP = 2; // matches .tabs CSS gap
/** Total tabs across every panel of the workspace this window is showing. */
function countTabsInWindow(): number {
  const state = useAppStore.getState();
  const path = state.activeWorkspacePath;
  if (!path) return 0;
  const layout = state.workspaceLayouts[path];
  if (!layout) return 0;
  return Object.values(layout.panels).reduce((n, p) => n + p.tabs.length, 0);
}

/**
 * The tab's displayed title, computed the same way `useTabTitle` does. The drag
 * chip must show this — not the raw `tab.title`, which is a stale placeholder
 * for terminal tabs (the live title lives in the pane side-maps).
 */
function deriveTabTitle(focusedPaneId: string): string {
  const s = useAppStore.getState();
  const title = s.paneTitle[focusedPaneId] ?? null;
  const cwd = s.paneCwd[focusedPaneId] ?? null;
  const contentType = s.paneContentType[focusedPaneId] ?? null;
  const paneUrl = s.paneUrl[focusedPaneId] ?? null;

  if (contentType === "diff") return "Diff";
  if (contentType === "browser") {
    if (title) return title;
    if (paneUrl) return paneUrl.replace(/^https?:\/\//, "");
  }
  if (title) {
    const cwdMatch = title.match(/^.+@.+:(.+)$/);
    if (cwdMatch) {
      const parts = cwdMatch[1].replace(/\/+$/, "").split("/");
      return parts[parts.length - 1] || title;
    }
    return title;
  }
  if (cwd) {
    const parts = cwd.split("/");
    return parts[parts.length - 1] || parts[parts.length - 2] || cwd;
  }
  return "Terminal";
}

// Lucide `globe` / `git-compare-arrows`, inlined for the drag image (a raw DOM
// element, so it can't use the React icon components the tab renders).
const GLOBE_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`;
const DIFF_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="3"/><path d="M12 6h5a2 2 0 0 1 2 2v7"/><path d="m15 9-3-3 3-3"/><circle cx="19" cy="18" r="3"/><path d="M12 18H7a2 2 0 0 1-2-2V9"/><path d="m9 15 3 3-3 3"/></svg>`;

/**
 * Build the OS drag image element (styled as an app tab) handed to
 * `DataTransfer.setDragImage`. The caller appends it to the DOM briefly so the
 * OS can snapshot it, then removes it.
 */
function buildTabDragImage(
  title: string,
  contentType: string | undefined,
  favicon: string | undefined,
): HTMLDivElement {
  const el = document.createElement("div");
  el.className = styles.tabDragImage;
  let iconHtml = "";
  if (contentType === "browser") {
    iconHtml = favicon
      ? `<img src="${favicon.replace(/"/g, "&quot;")}" width="12" height="12" />`
      : GLOBE_SVG;
  } else if (contentType === "diff") {
    iconHtml = DIFF_SVG;
  }
  const label = document.createElement("span");
  label.textContent = title;
  el.innerHTML = iconHtml;
  el.appendChild(label);
  return el;
}

type TabBarProps = {
  onNewTask: () => void;
  panelId?: string;
  workspacePath?: string;
};

export function TabBar(props: TabBarProps) {
  const { onNewTask, panelId, workspacePath } = props;

  const panel = useAppStore((s) => {
    if (panelId && workspacePath) {
      return s.workspaceLayouts[workspacePath]?.panels[panelId] ?? null;
    }
    return selectActiveWorkspace(s);
  });
  const tabs = useMemo(() => panel?.tabs ?? [], [panel?.tabs]);
  const selectedTabId = panel?.selectedTabId ?? null;
  const selectTab = useAppStore((s) => s.selectTab);
  const addTab = useAppStore((s) => s.addTab);
  const addBrowserTab = useAppStore((s) => s.addBrowserTab);
  const requestCloseTab = useAppStore((s) => s.requestCloseTab);
  const togglePinTab = useAppStore((s) => s.togglePinTab);
  const pinnedTabIds = useMemo(
    () => panel?.pinnedTabIds ?? [],
    [panel?.pinnedTabIds],
  );

  const ensureFocused = useCallback(() => {
    if (panelId) {
      useAppStore.getState().focusPanel(panelId);
    }
  }, [panelId]);
  const sidebarVisible = useProjectStore((s) => s.sidebarVisible);
  const { drag, startDrag, endDrag } = usePaneDrag();
  const extractPaneToTab = useAppStore((s) => s.extractPaneToTab);

  const tabsRef = useRef<HTMLDivElement>(null);

  // Native HTML5 drag-and-drop (VS Code-style). The OS renders a single drag
  // image via `setDragImage`, so there is exactly one visual that follows the
  // cursor everywhere — in the tab bar, over panes, and out onto the desktop —
  // with no DOM ghost and no separate preview window to seam.
  const barRef = useRef<HTMLDivElement>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [mergeTargetTabId, setMergeTargetTabId] = useState<string | null>(null);
  const [splitDropHint, setSplitDropHint] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // The id of the tab this window is currently dragging (null when idle), and
  // the panel it came from — the source of truth for same-window drops, since
  // DataTransfer can only carry strings across the boundary.
  const draggedTabId = useRef<string | null>(null);
  const draggedFromPanelId = useRef<string | undefined>(undefined);
  // Set once we've torn a tab into a new window mid-drag (spawn-on-exit), so the
  // eventual dragend does not tear off a SECOND window.
  const tearOffCommitted = useRef(false);
  // Where inside the tab the pointer grabbed it, so a torn-off window / new
  // window lands with the tab under the cursor.
  const dragGrabOffset = useRef({ x: 0, y: 0 });
  // The dragged tab's position within the window at drag start, so an
  // orphan-window move can keep the tab under the cursor.
  const dragTabLeftInWindow = useRef(0);
  const dragTabTopInWindow = useRef(0);
  // Drag-out-to-detach (ADR-156): this window's outer bounds and the other
  // manor windows a tab can be dropped into, snapshotted at drag start so the
  // `dragend` hit-test needs no async IPC.
  const windowBounds = useRef<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const otherWindows = useRef<
    { id: number; bounds: { x: number; y: number; width: number; height: number } }[]
  >([]);

  // The tab this window is dragging, as seen by every panel in the window
  // (shared via PaneDragContext, since per-instance refs can't cross panels).
  const draggedId = drag?.type === "tab" ? drag.tabId : null;

  // Insertion index / merge target for a drop landing in THIS panel's bar.
  const computeIndicator = useCallback(
    (clientX: number): { insertion: number | null; merge: string | null } => {
      const pinnedCount = pinnedTabIds.length;
      let insertion = tabs.length;
      for (let i = 0; i < tabs.length; i++) {
        const el = itemRefs.current.get(i);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (clientX < r.left) {
          insertion = i;
          break;
        }
        if (clientX <= r.right) {
          const rel = (clientX - r.left) / r.width;
          // Central band of a (non-dragged) tab → merge into it; edges → reorder.
          if (rel > 0.3 && rel < 0.7 && tabs[i].id !== draggedId) {
            return { insertion: null, merge: tabs[i].id };
          }
          insertion = rel < 0.5 ? i : i + 1;
          break;
        }
      }
      // Unpinned tabs can't land in the pinned zone.
      insertion = Math.max(pinnedCount, insertion);
      return { insertion, merge: null };
    },
    [tabs, pinnedTabIds, draggedId],
  );

  const clearDragIndicators = useCallback(() => {
    setDropIndex(null);
    setMergeTargetTabId(null);
    setSplitDropHint(false);
  }, []);

  // ── dragstart: begin a native HTML5 drag for a tab ──────────────────────────
  const handleTabDragStart = useCallback(
    (idx: number, e: React.DragEvent) => {
      const tab = tabs[idx];
      const tabEl = e.currentTarget as HTMLElement;
      const rect = tabEl.getBoundingClientRect();
      const grabX = e.clientX - rect.left;
      const grabY = e.clientY - rect.top;
      dragGrabOffset.current = { x: grabX, y: grabY };
      dragTabLeftInWindow.current = rect.left;
      dragTabTopInWindow.current = rect.top;
      draggedTabId.current = tab.id;
      draggedFromPanelId.current = panelId;

      e.dataTransfer.effectAllowed = "move";
      // A string marker so drop targets can recognise our drag in dragover
      // (getData is unreadable there); the real payload is resolved from state.
      e.dataTransfer.setData("application/x-manor-tab", tab.id);

      // The single OS-rendered drag visual (VS Code-style). Rendered off-screen
      // just long enough for the OS to snapshot it.
      const st = useAppStore.getState();
      const img = buildTabDragImage(
        deriveTabTitle(tab.focusedPaneId),
        st.paneContentType[tab.focusedPaneId],
        st.paneFavicon[tab.focusedPaneId] ?? undefined,
      );
      document.body.appendChild(img);
      e.dataTransfer.setDragImage(img, grabX, grabY);
      setTimeout(() => img.remove(), 0);

      // Signal an active tab drag so pane drop zones render and highlight.
      startDrag({ type: "tab", tabId: tab.id, grabOffset: dragGrabOffset.current });
      setDragIndex(idx);
      tearOffCommitted.current = false;

      // Snapshot geometry for the dragend tear-off hit-test (no async there).
      windowBounds.current = null;
      otherWindows.current = [];
      void window.electronAPI.window
        .getBounds()
        .then((b) => {
          windowBounds.current = b;
        })
        .catch(() => {});
      void window.electronAPI.window
        .listWindows()
        .then((w) => {
          otherWindows.current = w;
        })
        .catch(() => {});
    },
    [tabs, panelId, startDrag],
  );

  // ── drag: fires continuously on the source, even outside the window ─────────
  // VS Code makes tear-off instant with a private Chromium patch that suppresses
  // the "drag failed" fly-back on a release outside the window. Stock Electron
  // has no such API, so we take Chrome's approach instead: the instant the tab
  // is dragged clearly OUTSIDE this window (and not over another manor window,
  // which would be a move-into-that-window on release), we detach it into a new
  // window right away — before release — so the window appears with no wait and
  // no fly-back. If the platform doesn't deliver screen coords out here, nothing
  // fires and we fall back to the on-release path in handleTabDragEnd.
  const handleTabDrag = useCallback(
    (e: React.DragEvent) => {
      if (tearOffCommitted.current) return;
      const tabId = draggedTabId.current;
      const b = windowBounds.current;
      if (!tabId || !b) return;
      const sx = e.screenX;
      const sy = e.screenY;
      // The final drag event (and some mid-drag ones) report 0,0 — ignore those.
      if (sx === 0 && sy === 0) return;

      const MARGIN = 8;
      const outside =
        sx < b.x - MARGIN ||
        sx > b.x + b.width + MARGIN ||
        sy < b.y - MARGIN ||
        sy > b.y + b.height + MARGIN;
      if (!outside) return;

      // Over another manor window → this is a move-into-that-window; let the
      // release (dragend) hand it off rather than spawning a new window here.
      const overOtherWindow = otherWindows.current.some(
        (w) =>
          sx >= w.bounds.x &&
          sx <= w.bounds.x + w.bounds.width &&
          sy >= w.bounds.y &&
          sy <= w.bounds.y + w.bounds.height,
      );
      if (overOtherWindow) return;

      // Sole tab of a detached window: tearing it off would orphan this window.
      // Leave that to the release path, which moves this window to the drop.
      if (window.electronAPI?.isDetached && countTabsInWindow() === 1) return;

      // Commit the new-window tear-off NOW.
      tearOffCommitted.current = true;
      const grab = dragGrabOffset.current;
      const store = useAppStore.getState();
      const payload = store.serializeTabForDetach(tabId);
      store.removeDetachedTabLocally(tabId);
      void trackHandoff(
        window.electronAPI.window.detachTab(payload, {
          x: Math.round(sx - grab.x),
          y: Math.round(sy - grab.y),
          width: 900,
          height: 600,
        }),
      ).catch((err) => console.error("Failed to tear tab into new window", err));

      clearDragIndicators();
      setDragIndex(null);
      draggedTabId.current = null;
      draggedFromPanelId.current = undefined;
      endDrag();
      // Emptying a popout closes it — but that is `DetachedApp`'s store
      // subscription's job, not ours. Closing the window from here would do it
      // synchronously, inside the drag event Chromium is still dispatching.
    },
    [endDrag, clearDragIndicators],
  );

  // ── dragover: this panel's bar is a drop target for a tab drag ──────────────
  const handleBarDragOver = useCallback(
    (e: React.DragEvent) => {
      // A dragged PANE dropped here extracts into a new tab. No insertion bar —
      // just mark the bar a valid drop target so the pane's dragend sees "move".
      if (e.dataTransfer.types.includes("application/x-manor-pane")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropIndex(null);
        setMergeTargetTabId(null);
        setSplitDropHint(false);
        return;
      }
      if (!draggedId) return;
      // preventDefault marks this a valid drop target → dropEffect becomes
      // "move", which is how the source's dragend knows the drop was handled
      // here (and must NOT tear off a new window).
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      const isOwnTab = tabs.some((t) => t.id === draggedId);
      if (isOwnTab) {
        const { insertion, merge } = computeIndicator(e.clientX);
        setDropIndex(merge === null ? insertion : null);
        setMergeTargetTabId(merge);
        setSplitDropHint(false);
      } else {
        // From another panel: right half → split, left half → move into panel.
        const bar = barRef.current;
        setSplitDropHint(
          bar
            ? e.clientX >
                bar.getBoundingClientRect().left +
                  bar.getBoundingClientRect().width / 2
            : false,
        );
        setDropIndex(null);
        setMergeTargetTabId(null);
      }
    },
    [draggedId, tabs, computeIndicator],
  );

  const handleBarDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when the pointer actually leaves the bar (not on child enter).
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropIndex(null);
    setMergeTargetTabId(null);
    setSplitDropHint(false);
  }, []);

  // ── drop: resolve the tab into this panel ───────────────────────────────────
  const handleBarDrop = useCallback(
    (e: React.DragEvent) => {
      // A dragged PANE dropped on the bar is extracted into a new tab here.
      const draggedPaneId = e.dataTransfer.getData("application/x-manor-pane");
      if (draggedPaneId) {
        e.preventDefault();
        e.stopPropagation();
        extractPaneToTab(draggedPaneId, panelId);
        clearDragIndicators();
        endDrag();
        return;
      }
      if (!draggedId) return;
      e.preventDefault();
      e.stopPropagation();
      const st = useAppStore.getState();
      const isOwnTab = tabs.some((t) => t.id === draggedId);

      if (mergeTargetTabId && mergeTargetTabId !== draggedId) {
        st.mergeTabIntoTab(draggedId, mergeTargetTabId);
      } else if (isOwnTab) {
        // Reorder within this panel to the insertion index.
        const { insertion } = computeIndicator(e.clientX);
        if (insertion !== null) {
          const ids = tabs.map((t) => t.id);
          const from = ids.indexOf(draggedId);
          if (from !== -1) {
            ids.splice(from, 1);
            let to = insertion > from ? insertion - 1 : insertion;
            to = Math.max(pinnedTabIds.length, Math.min(to, ids.length));
            ids.splice(to, 0, draggedId);
            st.reorderTabs(ids);
          }
        }
      } else if (panelId) {
        // From another panel: right half splits, left half moves.
        const bar = barRef.current;
        const rightHalf = bar
          ? e.clientX >
            bar.getBoundingClientRect().left +
              bar.getBoundingClientRect().width / 2
          : false;
        if (rightHalf) st.splitPanelWithTab(draggedId, panelId, "horizontal");
        else st.moveTabToPanel(draggedId, panelId);
      }
      clearDragIndicators();
      // Clear the shared drag state here, not only in dragend: a move/merge/split
      // unmounts the source tab, and Chromium may then never fire dragend — which
      // would leave the drag "active" and drop overlays showing on hover.
      draggedTabId.current = null;
      draggedFromPanelId.current = undefined;
      endDrag();
    },
    [
      draggedId,
      tabs,
      mergeTargetTabId,
      panelId,
      pinnedTabIds,
      computeIndicator,
      clearDragIndicators,
      endDrag,
      extractPaneToTab,
    ],
  );

  // ── dragend: fires on the source tab; the whole drag is over here ───────────
  const handleTabDragEnd = useCallback(
    (e: React.DragEvent) => {
      // Already detached mid-drag by spawn-on-exit — nothing left to do.
      if (tearOffCommitted.current) {
        tearOffCommitted.current = false;
        return;
      }
      const handledInApp = e.dataTransfer.dropEffect !== "none";
      const tabId = draggedTabId.current;
      const grab = dragGrabOffset.current;
      const tabLeft = dragTabLeftInWindow.current;
      const tabTop = dragTabTopInWindow.current;
      const sx = e.screenX;
      const sy = e.screenY;

      // Reset visuals + shared drag state.
      clearDragIndicators();
      setDragIndex(null);
      draggedTabId.current = null;
      draggedFromPanelId.current = undefined;
      endDrag();

      if (handledInApp || !tabId) return;

      // Not consumed by any in-app drop target. Where it landed decides:
      const bounds = windowBounds.current;
      const releasedOutside =
        bounds !== null &&
        (sx < bounds.x ||
          sx > bounds.x + bounds.width ||
          sy < bounds.y ||
          sy > bounds.y + bounds.height);
      // Dropped in dead space inside the window → cancel (no-op).
      if (!releasedOutside) return;

      // Topmost other window under the release point, if any.
      const target =
        otherWindows.current.find(
          (w) =>
            sx >= w.bounds.x &&
            sx <= w.bounds.x + w.bounds.width &&
            sy >= w.bounds.y &&
            sy <= w.bounds.y + w.bounds.height,
        ) ?? null;
      // Sole tab of a detached window: tearing it off would orphan this empty
      // window. Move this window to the drop point instead. (The primary window
      // is never an orphan: it falls back to Home.)
      const wouldOrphanWindow =
        target === null &&
        window.electronAPI?.isDetached === true &&
        countTabsInWindow() === 1;

      if (wouldOrphanWindow) {
        window.electronAPI.window.setPosition(
          Math.round(sx - grab.x - tabLeft),
          Math.round(sy - grab.y - tabTop),
        );
        return;
      }

      const store = useAppStore.getState();
      const payload = store.serializeTabForDetach(tabId);
      const spawnBounds = {
        x: Math.round(sx - grab.x),
        y: Math.round(sy - grab.y),
        width: 900,
        height: 600,
      };
      // Remove the tab from THIS window synchronously so the origin updates in
      // the same frame — no snap-back of a tab that is on its way out. Then fire
      // the destination-window IPC without awaiting, so the new window appears
      // immediately rather than after the drag's return animation. (Serialize
      // first: removeDetachedTabLocally releases the panes it references.)
      store.removeDetachedTabLocally(tabId);
      if (target) {
        void trackHandoff(
          window.electronAPI.window
            .transferTab(target.id, payload)
            .then((accepted) => {
              if (!accepted) {
                return window.electronAPI.window.detachTab(payload, spawnBounds);
              }
            }),
        ).catch((err) =>
          console.error("Failed to move tab out of this window", err),
        );
      } else {
        void trackHandoff(
          window.electronAPI.window.detachTab(payload, spawnBounds),
        ).catch((err) =>
          console.error("Failed to move tab out of this window", err),
        );
      }
      // A detached window that just gave away its last tab has nothing left to
      // show, and `DetachedApp`'s store subscription closes it — after the
      // handoff above has actually left this renderer. Closing it here instead
      // would race the payload and would run inside the `dragend` Chromium is
      // still dispatching.
    },
    [endDrag, clearDragIndicators],
  );

  // Pixel position of the reorder insertion bar within the tabs container.
  const insertionBarLeft = useMemo(() => {
    if (dropIndex === null || mergeTargetTabId !== null) return null;
    const container = tabsRef.current;
    if (!container) return null;
    const containerLeft = container.getBoundingClientRect().left;
    if (dropIndex <= 0) {
      const first = itemRefs.current.get(0);
      return first ? first.getBoundingClientRect().left - containerLeft : 0;
    }
    const prev = itemRefs.current.get(dropIndex - 1);
    if (prev) {
      return prev.getBoundingClientRect().right - containerLeft + TAB_GAP / 2;
    }
    return null;
  }, [dropIndex, mergeTargetTabId]);


  const isDragActive = drag !== null;
  const splitPanel = useAppStore((s) => s.splitPanel);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          ref={barRef}
          className={`${styles.tabBar} ${!sidebarVisible ? styles.noSidebar : ""} ${isDragActive ? styles.tabBarDropTarget : ""} ${splitDropHint ? styles.tabBarSplitHint : ""}`}
          onDragOver={handleBarDragOver}
          onDragLeave={handleBarDragLeave}
          onDrop={handleBarDrop}
        >
          <div ref={tabsRef} className={styles.tabs}>
            {tabs.map((tab, idx) => {
              const isPinned = pinnedTabIds.includes(tab.id);
              const isDropTarget = mergeTargetTabId === tab.id;
              return (
                <TabButton
                  key={tab.id}
                  tabId={tab.id}
                  isActive={tab.id === selectedTabId}
                  isPinned={isPinned}
                  canClose={true}
                  isDragging={dragIndex === idx}
                  isDropTarget={isDropTarget}
                  draggable={!isPinned}
                  onSelect={() => {
                    ensureFocused();
                    selectTab(tab.id);
                  }}
                  onClose={() => {
                    ensureFocused();
                    requestCloseTab(tab.id);
                  }}
                  onTogglePin={() => {
                    ensureFocused();
                    togglePinTab(tab.id);
                  }}
                  onDragStart={
                    isPinned ? undefined : (e) => handleTabDragStart(idx, e)
                  }
                  onDrag={isPinned ? undefined : handleTabDrag}
                  onDragEnd={isPinned ? undefined : handleTabDragEnd}
                  buttonRef={(el) => {
                    if (el) itemRefs.current.set(idx, el);
                    else itemRefs.current.delete(idx);
                  }}
                />
              );
            })}
            {insertionBarLeft !== null && (
              <div
                className={styles.tabInsertionBar}
                style={{ left: insertionBarLeft }}
              />
            )}
            <Popover.Root open={addMenuOpen} onOpenChange={setAddMenuOpen}>
              <Tooltip label={addMenuOpen ? "" : "New Tab"}>
                <Popover.Anchor asChild>
                  <button
                    className={styles.addButton}
                    onClick={() => { ensureFocused(); addTab(); }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setAddMenuOpen(true);
                    }}
                  >
                    <Plus size={14} />
                  </button>
                </Popover.Anchor>
              </Tooltip>
              <Popover.Portal>
                <Popover.Content
                  className={styles.contextMenu}
                  side="bottom"
                  align="center"
                  sideOffset={4}
                >
                  <button
                    className={styles.contextMenuItem}
                    onClick={() => {
                      ensureFocused();
                      addBrowserTab("about:blank");
                      setAddMenuOpen(false);
                    }}
                  >
                    <Globe size={14} />
                    Browser
                  </button>
                  <button
                    className={styles.contextMenuItem}
                    onClick={() => {
                      ensureFocused();
                      onNewTask();
                      setAddMenuOpen(false);
                    }}
                  >
                    <ListTodo size={14} />
                    Task
                  </button>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </div>
          <div className={styles.spacer} />
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={styles.contextMenu}>
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={() => {
              ensureFocused();
              splitPanel("horizontal");
            }}
          >
            Split Right
          </ContextMenu.Item>
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={() => {
              ensureFocused();
              splitPanel("vertical");
            }}
          >
            Split Down
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
