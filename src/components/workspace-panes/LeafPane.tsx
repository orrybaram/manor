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
import { usePaneDrag } from "./PaneDragContext";
import { TerminalPane } from "./TerminalPane/TerminalPane";
import { BrowserPane, type BrowserPaneRef, type BrowserPaneNavState } from "./BrowserPane/BrowserPane";
import { DiffPane, type DiffPaneRef } from "./DiffPane/DiffPane";
import { PaneDropZone } from "./PaneDropZone";
import { ConvertToSubmenu } from "./ConvertToSubmenu";
import { SplitWithSubmenu } from "./SplitWithSubmenu";
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
    setWebviewFocused(state.webviewFocused ? paneId : null);
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
    };
  });

  const dragStartX = useRef(0);
  const dragStartY = useRef(0);
  const dragActive = useRef(false);

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

  const handleStatusBarPointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (e.button !== 0) return;
    // Don't start drag when clicking a button
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("input")) return;

    const statusBarEl = e.currentTarget;
    const statusBarRect = statusBarEl.getBoundingClientRect();
    const pointerId = e.pointerId;
    dragStartX.current = e.clientX;
    dragStartY.current = e.clientY;
    dragActive.current = false;

    const grabOffset = {
      x: e.clientX - statusBarRect.left,
      y: e.clientY - statusBarRect.top,
    };

    statusBarEl.setPointerCapture(pointerId);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - dragStartX.current;
      const dy = ev.clientY - dragStartY.current;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (!dragActive.current && dist < 4) return;

      if (!dragActive.current) {
        dragActive.current = true;
        // Release pointer capture so drop zones on other panes can receive events
        try {
          statusBarEl.releasePointerCapture(pointerId);
        } catch {
          /* may already be released */
        }
        startDrag({ type: "pane", paneId, grabOffset });
      }
    };

    const cleanup = () => {
      statusBarEl.removeEventListener("pointermove", onMove);
      statusBarEl.removeEventListener("pointerup", onUp);
      statusBarEl.removeEventListener("lostpointercapture", onCaptureLost);
    };

    const onUp = () => {
      cleanup();
      dragActive.current = false;
    };

    // When pointer capture is released to start the drag, clean up status bar
    // listeners but keep dragActive true so the global cleanup can handle
    // drops that land outside any drop zone.
    const onCaptureLost = () => {
      cleanup();
    };

    statusBarEl.addEventListener("pointermove", onMove);
    statusBarEl.addEventListener("pointerup", onUp);
    statusBarEl.addEventListener("lostpointercapture", onCaptureLost);

    // Global listener to end drag if user drops outside any pane/tab bar
    const globalCleanup = (_ev: PointerEvent) => {
      if (!dragActive.current) {
        document.removeEventListener("pointerup", globalCleanup);
        return;
      }
      requestAnimationFrame(() => {
        endDrag();
      });
      document.removeEventListener("pointerup", globalCleanup);
    };
    document.addEventListener("pointerup", globalCleanup);
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
      <div
        className={`${styles.paneStatusBar} ${isFocused ? styles.paneStatusBarFocused : ""} ${isThisPaneDragging ? styles.paneStatusBarDragging : ""} ${navState?.webviewFocused ? styles.paneStatusBarWebviewFocused : ""}`}
        onPointerDown={handleStatusBarPointerDown}
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
