import { useRef, useState, useCallback } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right";
import RotateCw from "lucide-react/dist/esm/icons/rotate-cw";
import Crosshair from "lucide-react/dist/esm/icons/crosshair";
import ZoomIn from "lucide-react/dist/esm/icons/zoom-in";
import ZoomOut from "lucide-react/dist/esm/icons/zoom-out";
import Search from "lucide-react/dist/esm/icons/search";
import X from "lucide-react/dist/esm/icons/x";
import Lock from "lucide-react/dist/esm/icons/lock";
import Unlock from "lucide-react/dist/esm/icons/unlock";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import { useAppStore, selectActiveWorkspace } from "../../store/app-store";
import { hasPaneId } from "../../store/pane-tree";
import {
  isOutsideWindow,
  findWindowAtPoint,
  spawnBoundsFor,
  buildDragImage,
  type Bounds,
  type WindowInfo,
} from "../../lib/detach-drag";
import { usePaneDrag } from "./PaneDragContext";
import { TerminalPane } from "./TerminalPane/TerminalPane";
import { BrowserPane, type BrowserPaneRef, type BrowserPaneNavState } from "./BrowserPane/BrowserPane";
import { DiffPane, type DiffPaneRef } from "./DiffPane/DiffPane";
import { PaneDropZone } from "./PaneDropZone";
import { ConvertToSubmenu } from "./ConvertToSubmenu";
import { SplitWithSubmenu } from "./SplitWithSubmenu";
import { PaneWindowMenuItems } from "./PaneWindowMenuItems";
import { countPanesInWindow } from "../../lib/window-handoff";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import { Row } from "../ui/Layout/Layout";
import { registerBrowserPane, unregisterBrowserPane } from "../../lib/browser-pane-registry";
import { useMountEffect } from "../../hooks/useMountEffect";

import styles from "./PaneLayout/PaneLayout.module.css";
import browserStyles from "./BrowserPane/BrowserPane.module.css";

function stripUrlForDisplay(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/^www\./, "");
}

type LeafPaneProps = {
  paneId: string;
  workspacePath?: string;
};

export function LeafPane(props: LeafPaneProps) {
  const { paneId, workspacePath } = props;

  const focusedPaneId = useAppStore((s) => {
    const ws = selectActiveWorkspace(s);
    const tab = ws?.tabs.find((t) => t.id === ws.selectedTabId);
    return tab?.focusedPaneId;
  });
  const paneTitle = useAppStore((s) => s.paneTitle[paneId]);
  const paneCwd = useAppStore((s) => s.paneCwd[paneId]);
  const contentType = useAppStore((s) => s.paneContentType[paneId]);
  const paneUrl = useAppStore((s) => s.paneUrl[paneId]);

  const focusPane = useAppStore((s) => s.focusPane);
  const splitPane = useAppStore((s) => s.splitPane);
  const requestClosePaneById = useAppStore((s) => s.requestClosePaneById);
  const setWebviewFocused = useAppStore((s) => s.setWebviewFocused);
  const { drag, startDrag, endDrag } = usePaneDrag();
  const isFocused = focusedPaneId === paneId;

  const containerRef = useRef<HTMLDivElement>(null);
  const browserRef = useRef<BrowserPaneRef>(null);
  const diffRef = useRef<DiffPaneRef>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const [navState, setNavState] = useState<BrowserPaneNavState | null>(null);
  const [urlFocused, setUrlFocused] = useState(false);

  const setPaneFavicon = useAppStore((s) => s.setPaneFavicon);
  const handleNavStateChange = useCallback((state: BrowserPaneNavState) => {
    setNavState(state);
    setWebviewFocused(paneId, state.webviewFocused);
    setPaneFavicon(paneId, state.favicon);
  }, [paneId, setWebviewFocused, setPaneFavicon]);

  useMountEffect(() => {
    if (contentType !== "browser") return;
    // Register once browserRef is populated (after first render)
    const id = requestAnimationFrame(() => {
      if (browserRef.current) {
        registerBrowserPane(paneId, browserRef.current);
      }
      // Auto-focus URL bar for blank browser panes
      if (!paneUrl || paneUrl === "about:blank") {
        urlInputRef.current?.focus();
      }
    });
    return () => {
      cancelAnimationFrame(id);
      unregisterBrowserPane(paneId);
      // A closed/torn-off browser pane never fires blur, so drop any focus it
      // still owns — otherwise the status-bar BROWSER badge sticks around.
      setWebviewFocused(paneId, false);
    };
  });

  // Native HTML5 drag-and-drop tear-off (ADR-157), mirroring the tab bar: the
  // OS renders one drag image via setDragImage, and dragging the pane clearly
  // outside this window tears it into a new popout window (or hands it to
  // another manor window).
  // Set once we've torn this pane into a new window mid-drag (spawn-on-exit),
  // so the eventual dragend does not tear off a SECOND window.
  const tearOffCommitted = useRef(false);
  // Where inside the status bar the pointer grabbed it, so a torn-off / new
  // window lands with the chip under the cursor.
  const dragGrabOffset = useRef({ x: 0, y: 0 });
  // The status bar's position within the window at drag start, so an
  // orphan-window move can keep the chip under the cursor.
  const dragStatusBarLeftInWindow = useRef(0);
  const dragStatusBarTopInWindow = useRef(0);
  // This window's outer bounds and the other manor windows this pane could be
  // dropped into, snapshotted at drag start so the dragend hit-test needs no
  // async IPC.
  const windowBounds = useRef<Bounds | null>(null);
  const otherWindows = useRef<WindowInfo[]>([]);

  const dragTabId = drag?.type === "tab" ? drag.tabId : null;
  const paneIsInDraggedTab = useAppStore((s) => {
    if (!dragTabId) return false;
    const panel = selectActiveWorkspace(s);
    if (!panel) return false;
    const tab = panel.tabs.find((t) => t.id === dragTabId);
    return tab ? hasPaneId(tab.rootNode, paneId) : false;
  });

  const showDropZone =
    drag !== null &&
    !(drag.type === "pane" && drag.paneId === paneId) &&
    !paneIsInDraggedTab;

  let title =
    paneTitle || (paneCwd ? paneCwd.split("/").pop() : "") || "Terminal";
  // Strip "user@host:" prefix from default shell titles
  title = title.replace(/^.+@.+:/, "");

  const handleSplit = (e: React.MouseEvent) => {
    e.stopPropagation();
    focusPane(paneId);
    const el = containerRef.current;
    const direction = el && el.offsetWidth >= el.offsetHeight ? "horizontal" : "vertical";
    splitPane(direction);
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    focusPane(paneId);
    requestClosePaneById(paneId);
  };

  // ── dragstart: begin a native HTML5 drag for this pane ──────────────────────
  const handleStatusBarDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    // Don't start a drag when the grab lands on a button/input in the bar.
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("input")) {
      e.preventDefault();
      return;
    }

    const statusBarEl = e.currentTarget;
    const rect = statusBarEl.getBoundingClientRect();
    const grabX = e.clientX - rect.left;
    const grabY = e.clientY - rect.top;
    dragGrabOffset.current = { x: grabX, y: grabY };
    dragStatusBarLeftInWindow.current = rect.left;
    dragStatusBarTopInWindow.current = rect.top;

    e.dataTransfer.effectAllowed = "move";
    // A string marker so drop targets can recognise our drag in dragover
    // (getData is unreadable there); the real payload is resolved from state.
    e.dataTransfer.setData("application/x-manor-pane", paneId);

    // The single OS-rendered drag visual, rendered off-screen just long enough
    // for the OS to snapshot it. Mirrors an app tab chip.
    const s = useAppStore.getState();
    const img = buildDragImage(
      styles.paneDragImage,
      title,
      s.paneContentType[paneId],
      s.paneFavicon[paneId] ?? undefined,
    );
    document.body.appendChild(img);
    e.dataTransfer.setDragImage(img, grabX, grabY);
    setTimeout(() => img.remove(), 0);

    // Signal an active pane drag so pane drop zones render and highlight.
    startDrag({ type: "pane", paneId, grabOffset: dragGrabOffset.current });
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
  };

  // ── drag: fires continuously on the source, even outside the window ─────────
  // Spawn-on-exit tear-off (see TabBar for the full rationale): the instant the
  // pane is dragged clearly OUTSIDE this window (and not over another manor
  // window, which would be a move-into-that-window on release), detach it into
  // a new window right away — before release — so the window appears with no
  // wait and no fly-back.
  const handleStatusBarDrag = (e: React.DragEvent<HTMLDivElement>) => {
    if (tearOffCommitted.current) return;
    const b = windowBounds.current;
    if (!b) return;
    const sx = e.screenX;
    const sy = e.screenY;
    // The final drag event (and some mid-drag ones) report 0,0 — ignore those.
    if (sx === 0 && sy === 0) return;

    if (!isOutsideWindow(sx, sy, b)) return;

    // Over another manor window → this is a move-into-that-window; let the
    // release (dragend) hand it off rather than spawning a new window here.
    if (findWindowAtPoint(sx, sy, otherWindows.current)) return;

    // Sole pane of a detached window: tearing it off would orphan this window.
    // Leave that to the release path, which moves this window to the drop.
    if (window.electronAPI?.isDetached && countPanesInWindow() === 1) return;

    // Commit the new-window tear-off NOW.
    tearOffCommitted.current = true;
    const grab = dragGrabOffset.current;
    const store = useAppStore.getState();
    const payload = store.serializePaneForDetach(paneId);
    store.removeDetachedPaneLocally(paneId);
    void window.electronAPI.window
      .detachTab(payload, spawnBoundsFor(sx, sy, grab))
      .catch((err) => console.error("Failed to tear pane into new window", err));

    endDrag();
    if (window.electronAPI?.isDetached && countPanesInWindow() === 0) {
      window.electronAPI.window.closeSelf();
    }
  };

  // ── dragend: fires on the source; the whole drag is over here ───────────────
  const handleStatusBarDragEnd = (e: React.DragEvent<HTMLDivElement>) => {
    // Already detached mid-drag by spawn-on-exit — nothing left to do.
    if (tearOffCommitted.current) {
      tearOffCommitted.current = false;
      return;
    }
    const handledInApp = e.dataTransfer.dropEffect !== "none";
    const grab = dragGrabOffset.current;
    const barLeft = dragStatusBarLeftInWindow.current;
    const barTop = dragStatusBarTopInWindow.current;
    const sx = e.screenX;
    const sy = e.screenY;

    // Clear shared drag state.
    endDrag();

    // Consumed by an in-app drop target (a PaneDropZone / TabBar) — done.
    if (handledInApp) return;

    // Not consumed by any in-app drop target. Where it landed decides:
    const bounds = windowBounds.current;
    const releasedOutside = bounds !== null && isOutsideWindow(sx, sy, bounds, 0);
    // Dropped in dead space inside the window → cancel (no-op).
    if (!releasedOutside) return;

    // Topmost other window under the release point, if any.
    const target = findWindowAtPoint(sx, sy, otherWindows.current);
    // Sole pane of a detached window: tearing it off would orphan this empty
    // window. Move this window to the drop point instead. (The primary window
    // is never an orphan: it falls back to Home.)
    const wouldOrphanWindow =
      target === null &&
      window.electronAPI?.isDetached === true &&
      countPanesInWindow() === 1;

    if (wouldOrphanWindow) {
      window.electronAPI.window.setPosition(
        Math.round(sx - grab.x - barLeft),
        Math.round(sy - grab.y - barTop),
      );
      return;
    }

    const store = useAppStore.getState();
    const payload = store.serializePaneForDetach(paneId);
    const spawnBounds = spawnBoundsFor(sx, sy, grab);
    // Remove the pane from THIS window synchronously so the origin updates in
    // the same frame, then fire the destination IPC without awaiting.
    // (Serialize first: removeDetachedPaneLocally releases the panes.)
    store.removeDetachedPaneLocally(paneId);
    if (target) {
      void window.electronAPI.window
        .transferTab(target.id, payload)
        .then((accepted) => {
          if (!accepted) {
            void window.electronAPI.window.detachTab(payload, spawnBounds);
          }
        })
        .catch((err) =>
          console.error("Failed to move pane out of this window", err),
        );
    } else {
      void window.electronAPI.window
        .detachTab(payload, spawnBounds)
        .catch((err) =>
          console.error("Failed to move pane out of this window", err),
        );
    }
    // A detached window that just gave away its last pane has nothing left to
    // show — close it rather than orphan it.
    if (window.electronAPI?.isDetached && countPanesInWindow() === 0) {
      window.electronAPI.window.closeSelf();
    }
  };

  const isThisPaneDragging = drag?.type === "pane" && drag.paneId === paneId;

  return (
    <div
      ref={containerRef}
      data-pane-id={paneId}
      data-testid="workspace-pane"
      className={`${styles.leaf} ${isFocused ? styles.leafFocused : ""} ${isThisPaneDragging ? styles.leafDragging : ""}`}
      onMouseDown={() => focusPane(paneId)}
    >
      <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
      <div
        className={`${styles.paneStatusBar} ${isFocused ? styles.paneStatusBarFocused : ""} ${isThisPaneDragging ? styles.paneStatusBarDragging : ""} ${navState?.webviewFocused ? styles.paneStatusBarWebviewFocused : ""}`}
        draggable
        onDragStart={handleStatusBarDragStart}
        onDrag={handleStatusBarDrag}
        onDragEnd={handleStatusBarDragEnd}
      >
        {contentType === "diff" ? (
          <span className={styles.paneStatusTitle}>Diff</span>
        ) : contentType === "browser" ? (
          <div className={styles.paneNavControls}>
            <Tooltip label="Back">
              <button
                className={styles.paneStatusBtn}
                onClick={() => browserRef.current?.goBack()}
                disabled={!navState?.canGoBack}
                title="Back"
              >
                <ArrowLeft size={12} />
              </button>
            </Tooltip>
            <Tooltip label="Forward">
              <button
                className={styles.paneStatusBtn}
                onClick={() => browserRef.current?.goForward()}
                disabled={!navState?.canGoForward}
                title="Forward"
              >
                <ArrowRight size={12} />
              </button>
            </Tooltip>
            {navState?.isLoading ? (
              <Tooltip label="Stop">
                <button
                  className={styles.paneStatusBtn}
                  onClick={() => browserRef.current?.stop()}
                  title="Stop"
                >
                  <X size={12} />
                </button>
              </Tooltip>
            ) : (
              <Tooltip label="Reload">
                <button
                  className={styles.paneStatusBtn}
                  onClick={() => browserRef.current?.reload()}
                  title="Reload"
                >
                  <RotateCw size={12} />
                </button>
              </Tooltip>
            )}
            <div className={styles.paneUrlInputWrapper}>
              {!navState?.isBlank && (
                <>
                  {navState?.isSecure ? (
                    <Lock size={10} className={styles.paneSecureIcon} />
                  ) : (
                    <Unlock size={10} className={styles.paneInsecureIcon} />
                  )}
                </>
              )}
              <input
                ref={urlInputRef}
                data-pane-url-input={paneId}
                className={styles.paneUrlInput}
                value={urlFocused ? (navState?.url ?? "") : stripUrlForDisplay(navState?.url ?? "")}
                onChange={browserRef.current?.urlInputHandlers.onChange ?? (() => {})}
                onKeyDown={browserRef.current?.urlInputHandlers.onKeyDown}
                onBlur={() => {
                  setUrlFocused(false);
                  browserRef.current?.urlInputHandlers.onBlur();
                }}
                onFocus={(e) => {
                  setUrlFocused(true);
                  browserRef.current?.urlInputHandlers.onFocus(e);
                }}
                // Keep the native input menu (copy/paste/lookup) on the URL bar
                // instead of the pane's window menu.
                onContextMenu={(e) => e.stopPropagation()}
                placeholder="Enter URL"
                spellCheck={false}
                autoFocus={!paneUrl || paneUrl === "about:blank"}
              />
            </div>
            <Tooltip label="Pick element">
              <button
                className={`${styles.paneStatusBtn} ${navState?.pickerActive ? styles.paneStatusBtnActive : ""}`}
                onClick={() => navState?.pickerActive ? browserRef.current?.cancelPicker() : browserRef.current?.startPicker()}
                title="Pick element"
              >
                <Crosshair size={12} />
              </button>
            </Tooltip>
            <Tooltip label="Zoom in">
              <button
                className={styles.paneStatusBtn}
                onClick={() => browserRef.current?.zoomIn()}
                title="Zoom in"
              >
                <ZoomIn size={12} />
              </button>
            </Tooltip>
            <Tooltip label="Zoom out">
              <button
                className={styles.paneStatusBtn}
                onClick={() => browserRef.current?.zoomOut()}
                title="Zoom out"
              >
                <ZoomOut size={12} />
              </button>
            </Tooltip>
          </div>
        ) : (
          <span className={styles.paneStatusTitle}>{title}</span>
        )}
        <Row align="center" gap="2xs" className={styles.paneStatusActions}>
          {contentType === "diff" && (
            <Tooltip label="Search">
              <button
                className={styles.paneStatusBtn}
                onClick={(e) => { e.stopPropagation(); diffRef.current?.toggleSearch(); }}
                title="Search in diff"
              >
                <Search size={12} />
              </button>
            </Tooltip>
          )}
          <button
            className={styles.paneStatusBtn}
            onClick={handleSplit}
            title="Split pane"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <rect
                x="1"
                y="1"
                width="14"
                height="14"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
              />
              <line
                x1="8"
                y1="1.5"
                x2="8"
                y2="14.5"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          </button>
          <button
            className={styles.paneStatusBtn}
            onClick={handleClose}
            title="Close pane"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <line
                x1="3"
                y1="3"
                x2="13"
                y2="13"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <line
                x1="13"
                y1="3"
                x2="3"
                y2="13"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          </button>
        </Row>
      </div>
      </ContextMenu.Trigger>
      {/* The status bar is the one strip of a pane that is always ours to
          right-click: a browser pane's webview swallows the context menu, and a
          terminal's belongs to the terminal. */}
      <ContextMenu.Portal>
        <ContextMenu.Content className={styles.contextMenu}>
          <PaneWindowMenuItems paneId={paneId} />
          <ContextMenu.Separator className={styles.contextMenuSeparator} />
          <ContextMenu.Item
            className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
            onSelect={() => requestClosePaneById(paneId)}
          >
            <X size={14} />
            Close Pane
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
      </ContextMenu.Root>
      {contentType === "browser" && navState?.findBarOpen && (
        <div className={browserStyles.findBar}>
          <Search size={12} className={browserStyles.findBarIcon} />
          <input
            className={browserStyles.findBarInput}
            value={navState.findQuery}
            onChange={(e) => {
              browserRef.current?.findInPage(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                browserRef.current?.findInPage(navState.findQuery, {
                  forward: !e.shiftKey,
                  findNext: true,
                });
              } else if (e.key === "Escape") {
                e.preventDefault();
                browserRef.current?.stopFind();
              }
            }}
            placeholder="Find in page"
            spellCheck={false}
            autoFocus
          />
          {navState.findTotalMatches > 0 && (
            <span className={browserStyles.findBarCount}>
              {navState.findActiveMatch}/{navState.findTotalMatches}
            </span>
          )}
          <button
            className={styles.paneStatusBtn}
            onClick={() => browserRef.current?.findInPage(navState.findQuery, { forward: false, findNext: true })}
            title="Previous match"
          >
            <ChevronUp size={12} />
          </button>
          <button
            className={styles.paneStatusBtn}
            onClick={() => browserRef.current?.findInPage(navState.findQuery, { forward: true, findNext: true })}
            title="Next match"
          >
            <ChevronDown size={12} />
          </button>
          <button
            className={styles.paneStatusBtn}
            onClick={() => browserRef.current?.stopFind()}
            title="Close find"
          >
            <X size={12} />
          </button>
        </div>
      )}
      {contentType === "browser" && navState && navState.suggestions.length > 0 && (
        <div className={browserStyles.autocompleteDropdown}>
          {navState.suggestions.map((entry, idx) => (
            <div
              key={entry.url}
              className={`${browserStyles.autocompleteItem} ${idx === navState.highlightIndex ? browserStyles.autocompleteItemHighlighted : ""}`}
              onMouseDown={() => browserRef.current?.onSuggestionMouseDown(entry)}
            >
              <span className={browserStyles.autocompleteTitle}>{entry.title || entry.url}</span>
              <span className={browserStyles.autocompleteUrl}>{entry.url}</span>
            </div>
          ))}
        </div>
      )}
      <div className={`${styles.leafTerminal} ${contentType !== "diff" && contentType !== "browser" ? styles.leafTerminalInset : ""} ${navState?.webviewFocused ? browserStyles.webviewFocused : ""}`}>
        {contentType === "diff" ? (
          <PaneContextMenu paneId={paneId} containerRef={containerRef} onClose={() => requestClosePaneById(paneId)}>
            <DiffPane ref={diffRef} workspacePath={workspacePath} />
          </PaneContextMenu>
        ) : contentType === "browser" ? (
          <PaneContextMenu paneId={paneId} containerRef={containerRef} onClose={() => requestClosePaneById(paneId)}>
            <BrowserPane
              ref={browserRef}
              paneId={paneId}
              initialUrl={paneUrl ?? "about:blank"}
              onNavStateChange={handleNavStateChange}
            />
          </PaneContextMenu>
        ) : (
          <TerminalPane paneId={paneId} cwd={paneCwd || workspacePath} />
        )}
      </div>
      {showDropZone && <PaneDropZone paneId={paneId} />}
    </div>
  );
}

function PaneContextMenu({ paneId, containerRef, onClose, children }: {
  paneId: string;
  containerRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div style={{ display: "contents" }}>
          {children}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={styles.contextMenu}>
          <SplitWithSubmenu paneId={paneId} containerRef={containerRef} />
          <ConvertToSubmenu paneId={paneId} />
          <ContextMenu.Separator className={styles.contextMenuSeparator} />
          <PaneWindowMenuItems paneId={paneId} />
          <ContextMenu.Separator className={styles.contextMenuSeparator} />
          <ContextMenu.Item
            className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
            onSelect={onClose}
          >
            <X size={14} />
            Close Pane
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
