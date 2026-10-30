import { useRef, useState, useCallback, useEffect, forwardRef, useImperativeHandle } from "react";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { selectPaneUrl, useAppStore } from "../../../store/app-store";
import { useBrowserHistoryStore, type HistoryEntry } from "../../../store/browser-history-store";
import { useDragOverlayStore, selectIsDragActive } from "../../../store/drag-overlay-store";
import { onUiRequest } from "../../../utils/ui-request";
import { useRemoteBrowserUrl } from "../../../hooks/useRemoteBrowserUrl";
import { HostIndicator } from "../../hosts/HostIndicator";
import { siteLabel } from "./site-label";
import type { PageDialog } from "../../../../electron/webview-dialogs";
import { PageDialogOverlay } from "./PageDialogOverlay";
import { LoadProblemPage } from "./LoadProblemPage";
import { useLoadProblem } from "./useLoadProblem";
import { BlankPage } from "./BlankPage";
import { splitDirectionBeside } from "../../../lib/open-in-file-pane";
import type { WorkspaceKey } from "../../../lib/workspace-key";
import { DEFAULT_DOCK_FRACTION, type DevToolsDockSide } from "../../../lib/devtools-dock";
import { DevToolsDock } from "./DevToolsDock";
import { PageNotesOverlay } from "./PageNotes";
import { usePageNotes } from "./usePageNotes";

import styles from "./BrowserPane.module.css";

/** Electron webview element with navigation methods. */
interface WebviewElement extends HTMLElement {
  src: string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  getWebContentsId(): number;
}

interface WebviewTitleEvent extends Event {
  title: string;
}

interface WebviewTargetUrlEvent extends Event {
  url: string;
}

export interface BrowserPaneNavState {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  pickerActive: boolean;
  isBlank: boolean;
  suggestions: HistoryEntry[];
  highlightIndex: number;
  webviewFocused: boolean;
  isLoading: boolean;
  isSecure: boolean;
  favicon: string | null;
  findBarOpen: boolean;
  findQuery: string;
  findActiveMatch: number;
  findTotalMatches: number;
  audible: boolean;
  muted: boolean;
  /** The page's DevTools are open, docked in the pane. */
  devToolsOpen: boolean;
}

export interface BrowserPaneRef {
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  /** Arm picking: each click on the page adds a note, until Escape. */
  startPicker(): void;
  cancelPicker(): void;
  togglePicker(): void;
  navigate(url: string): void;
  focusUrlInput(): void;
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
  findInPage(query: string, options?: { forward?: boolean; findNext?: boolean }): void;
  stopFind(): void;
  toggleFindBar(): void;
  toggleMute(): void;
  /** Open or close the page's DevTools, docked in the pane. */
  toggleDevTools(): void;
  /** Stop this pane's active recording, if any. */
  stopRecording(): void;
  /** Current value of the URL input (controlled by BrowserPane). */
  getUrlInputValue(): string;
  /** Handlers for the URL input element rendered by LeafPane. */
  urlInputHandlers: {
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    onBlur: () => void;
    onFocus: (e: React.FocusEvent<HTMLInputElement>) => void;
  };
  onSuggestionMouseDown: (entry: HistoryEntry) => void;
}

type BrowserPaneProps = {
  paneId: string;
  initialUrl: string;
  /**
   * The remote host this pane's workspace lives on, or null for this
   * machine. A `localhost:<port>` URL for a port that host reports goes
   * through a port forward.
   */
  remoteHostId?: string | null;
  /** The pane's project, so the host-away overlay can open its Host settings. */
  projectId?: string;
  /** The pane's workspace, whose dev servers a blank pane lists. */
  workspaceKey?: WorkspaceKey;
  onNavStateChange?: (state: BrowserPaneNavState) => void;
};

// React 19 silently drops a boolean `allowpopups={true}` on <webview>, leaving
// the attribute absent — which makes Electron block all guest window.open /
// target=_blank before they reach setWindowOpenHandler. Emit it as a string
// attribute instead (Electron only checks for presence). Spread to bypass the
// boolean prop type in React's WebViewHTMLAttributes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WEBVIEW_ALLOW_POPUPS: any = { allowpopups: "true" };

export const BrowserPane = forwardRef<BrowserPaneRef, BrowserPaneProps>(
  function BrowserPane(props: BrowserPaneProps, ref) {
    const { paneId, initialUrl, remoteHostId = null, projectId, workspaceKey, onNavStateChange } = props;

    const webviewRef = useRef<WebviewElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // Remote panes load `localhost:<port>` URLs through a port
    // forward rather than on this machine — everything about that lives in
    // this hook.
    const remoteBrowserUrl = useRemoteBrowserUrl({
      paneId,
      remoteHostId,
      initialUrl,
      webviewRef,
    });
    // The error and crash pages.
    const loadProblem = useLoadProblem(paneId, webviewRef);
    const [url, setUrl] = useState(initialUrl === "about:blank" ? "" : initialUrl);
    const [isBlank, setIsBlank] = useState(initialUrl === "about:blank");
    const [isLoading, setIsLoading] = useState(false);
    const [suggestions, setSuggestions] = useState<HistoryEntry[]>([]);
    const [highlightIndex, setHighlightIndex] = useState(-1);
    const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // The URL last asked for or shown as the page, as the pane names it (a
    // remote pane's box URL): a load that fails never commits, so the
    // remembered URL can still be the page before it.
    const shownUrlRef = useRef<string | null>(null);
    // The same, for the notes pill to say whether its notes are on this page.
    const [shownUrl, setShownUrl] = useState(initialUrl);
    // The page's open alert/confirm/prompt; the first is shown. The page is
    // blocked on it, so there is rarely more than one.
    const [dialogs, setDialogs] = useState<PageDialog[]>([]);
    // The link under the pointer (or focused), for the status bubble.
    const [targetUrl, setTargetUrl] = useState("");

    const isDragActive = useDragOverlayStore(selectIsDragActive);

    // Docked DevTools. Whether they are open is main's to say
    // (`webview:devtools-changed`): Inspect Element and the page's own ⌥⌘I
    // open them without asking here. Side and size are this pane's, kept for
    // its lifetime; each side remembers its own size.
    const [devToolsOpen, setDevToolsOpen] = useState(false);
    const [dockSide, setDockSide] = useState<DevToolsDockSide>("bottom");
    const [dockFractions, setDockFractions] = useState<Record<DevToolsDockSide, number>>({
      bottom: DEFAULT_DOCK_FRACTION,
      right: DEFAULT_DOCK_FRACTION,
    });
    const [dockResizing, setDockResizing] = useState(false);
    const splitRef = useRef<HTMLDivElement>(null);
    const setDockFraction = useCallback(
      (fraction: number) => setDockFractions((prev) => ({ ...prev, [dockSide]: fraction })),
      [dockSide],
    );

    const setPaneTitle = useAppStore((s) => s.setPaneTitle);
    const setPaneUrl = useAppStore((s) => s.setPaneUrl);
    const clearPickedElement = useAppStore((s) => s.clearPickedElement);

    // Track nav state in a ref so we can read it synchronously in imperative callbacks
    const navStateRef = useRef<BrowserPaneNavState>({
      url: initialUrl === "about:blank" ? "" : initialUrl,
      canGoBack: false,
      canGoForward: false,
      pickerActive: false,
      isBlank: initialUrl === "about:blank",
      suggestions: [],
      highlightIndex: -1,
      webviewFocused: false,
      isLoading: false,
      isSecure: false,
      favicon: null,
      findBarOpen: false,
      findQuery: "",
      findActiveMatch: 0,
      findTotalMatches: 0,
      audible: false,
      muted: false,
      devToolsOpen: false,
    });

    const onNavStateChangeRef = useRef(onNavStateChange);
    onNavStateChangeRef.current = onNavStateChange;

    const fireNavStateChange = useCallback((overrides: Partial<BrowserPaneNavState>) => {
      navStateRef.current = { ...navStateRef.current, ...overrides };
      onNavStateChangeRef.current?.(navStateRef.current);
    }, []);

    // Notes picked on the page, and the pins that mark them.
    const [picking, setPicking] = useState(false);
    const setPickingState = useCallback((active: boolean) => {
      setPicking(active);
      fireNavStateChange({ pickerActive: active });
    }, [fireNavStateChange]);
    const pageNotes = usePageNotes({
      paneId,
      webviewRef,
      workspaceKey,
      pageUrl: () => shownUrlRef.current ?? initialUrl,
      onPickingChange: setPickingState,
    });
    const { start: startPins, stop: stopPins } = pageNotes;
    const startPicking = useCallback(() => {
      if (navStateRef.current.pickerActive) return;
      setPickingState(true);
      void startPins().then((started) => {
        if (!started) setPickingState(false);
      });
    }, [startPins, setPickingState]);
    const stopPicking = useCallback(() => {
      if (!navStateRef.current.pickerActive) return;
      stopPins();
      setPickingState(false);
    }, [stopPins, setPickingState]);

    const updateNavState = useCallback(() => {
      const wv = webviewRef.current;
      if (!wv) return;
      try {
        const back = wv.canGoBack();
        const forward = wv.canGoForward();
        fireNavStateChange({ canGoBack: back, canGoForward: forward });
      } catch {
        // webview not ready yet
      }
    }, [fireNavStateChange]);

    const navigateTo = useCallback((target: string) => {
      const wv = webviewRef.current;
      if (!wv) return;
      let resolved = target.trim();
      // Pass through explicit URL schemes (http(s), file, data, about, …) as
      // typed; only bare hosts / search terms get normalized below.
      if (!/^(https?|file|data|about|blob|chrome|view-source):/i.test(resolved)) {
        const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(resolved);
        if (isLocal) {
          resolved = `http://${resolved}`;
        } else if (/^[\w-]+(\.[\w-]+)+/.test(resolved)) {
          // Has dots — treat as a domain (e.g. "github.com", "foo.bar.com/path")
          resolved = `https://${resolved}`;
        } else {
          // No dots, no scheme, not localhost — treat as a search query
          resolved = `https://www.google.com/search?q=${encodeURIComponent(resolved)}`;
        }
      }
      setSuggestions([]);
      setHighlightIndex(-1);
      // In a remote workspace, `localhost:<port>` may mean a dev server on
      // the box; main swaps in the port forward's local port when the
      // host's scan reports that port, and hands anything else back as is.
      remoteBrowserUrl.navigate(resolved);
      shownUrlRef.current = resolved;
      setShownUrl(resolved);
      setUrl(resolved);
      fireNavStateChange({ url: resolved, suggestions: [], highlightIndex: -1 });
    }, [fireNavStateChange, remoteBrowserUrl]);

    // URL input handlers — kept here so url/nav state management stays in BrowserPane.
    // LeafPane will render the actual <input> and wire these up via the ref (ticket 2).
    const handleUrlChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setUrl(value);
      const results = useBrowserHistoryStore.getState().search(value);
      setSuggestions(results);
      setHighlightIndex(-1);
      fireNavStateChange({ url: value, suggestions: results, highlightIndex: -1 });
    }, [fireNavStateChange]);

    const urlRef = useRef(url);
    urlRef.current = url;

    const suggestionsRef = useRef(suggestions);
    suggestionsRef.current = suggestions;

    const highlightIndexRef = useRef(highlightIndex);
    highlightIndexRef.current = highlightIndex;

    const handleUrlKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
      const currentSuggestions = suggestionsRef.current;
      const currentHighlight = highlightIndexRef.current;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = currentSuggestions.length === 0 ? -1 : Math.min(currentHighlight + 1, currentSuggestions.length - 1);
        setHighlightIndex(next);
        fireNavStateChange({ highlightIndex: next });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const next = Math.max(currentHighlight - 1, -1);
        setHighlightIndex(next);
        fireNavStateChange({ highlightIndex: next });
      } else if (e.key === "Escape") {
        setSuggestions([]);
        setHighlightIndex(-1);
        fireNavStateChange({ suggestions: [], highlightIndex: -1 });
      } else if (e.key === "Enter") {
        if (currentHighlight >= 0 && currentSuggestions[currentHighlight]) {
          navigateTo(currentSuggestions[currentHighlight].url);
        } else {
          navigateTo(urlRef.current);
        }
      }
    }, [navigateTo, fireNavStateChange]);

    const handleUrlBlur = useCallback(() => {
      blurTimerRef.current = setTimeout(() => {
        setSuggestions([]);
        setHighlightIndex(-1);
        fireNavStateChange({ suggestions: [], highlightIndex: -1 });
      }, 150);
    }, [fireNavStateChange]);

    const handleUrlFocus = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
      e.currentTarget.select();
    }, []);

    const handleSuggestionMouseDown = useCallback((entry: HistoryEntry) => {
      if (blurTimerRef.current) {
        clearTimeout(blurTimerRef.current);
        blurTimerRef.current = null;
      }
      navigateTo(entry.url);
    }, [navigateTo]);

    // Shared by the webview's own ⌘F (relayed as `webview:find`) and Edit ›
    // Find… targeting this pane by id.
    const openFindBar = useCallback(() => {
      fireNavStateChange({ findBarOpen: true });
    }, [fireNavStateChange]);

    useEffect(() => {
      return onUiRequest((request) => {
        if (request.type === "pane-search" && request.paneId === paneId) {
          openFindBar();
        }
      });
    }, [paneId, openFindBar]);

    useImperativeHandle(ref, () => ({
      goBack() {
        webviewRef.current?.goBack();
      },
      goForward() {
        webviewRef.current?.goForward();
      },
      reload() {
        webviewRef.current?.reload();
      },
      stop() {
        window.electronAPI.webview.stop(paneId);
      },
      startPicker() {
        startPicking();
      },
      cancelPicker() {
        stopPicking();
      },
      togglePicker() {
        if (navStateRef.current.pickerActive) stopPicking();
        else startPicking();
      },
      navigate(target: string) {
        navigateTo(target);
      },
      focusUrlInput() {
        // URL input is rendered by LeafPane; no-op placeholder
      },
      zoomIn() {
        window.electronAPI.webview.zoomIn(paneId);
      },
      zoomOut() {
        window.electronAPI.webview.zoomOut(paneId);
      },
      zoomReset() {
        window.electronAPI.webview.zoomReset(paneId);
      },
      findInPage(query: string, options?: { forward?: boolean; findNext?: boolean }) {
        fireNavStateChange({ findQuery: query });
        if (query) {
          window.electronAPI.webview.findInPage(paneId, query, options);
        }
      },
      stopFind() {
        window.electronAPI.webview.stopFindInPage(paneId);
        fireNavStateChange({ findBarOpen: false, findQuery: "", findActiveMatch: 0, findTotalMatches: 0 });
      },
      toggleFindBar() {
        const open = !navStateRef.current.findBarOpen;
        if (!open) {
          window.electronAPI.webview.stopFindInPage(paneId);
          fireNavStateChange({ findBarOpen: false, findQuery: "", findActiveMatch: 0, findTotalMatches: 0 });
        } else {
          openFindBar();
        }
      },
      toggleMute() {
        const newMuted = !navStateRef.current.muted;
        window.electronAPI.webview.setAudioMuted(paneId, newMuted);
        fireNavStateChange({ muted: newMuted });
        useAppStore.getState().setPaneAudioMuted(paneId, newMuted);
      },
      toggleDevTools() {
        if (navStateRef.current.devToolsOpen) {
          void window.electronAPI.webview.closeDevTools(paneId);
        } else {
          void window.electronAPI.webview.openDevTools(paneId);
        }
      },
      stopRecording() {
        void window.electronAPI.webview.stopRecording(paneId);
      },
      getUrlInputValue() {
        return urlRef.current;
      },
      urlInputHandlers: {
        onChange: handleUrlChange,
        onKeyDown: handleUrlKeyDown,
        onBlur: handleUrlBlur,
        onFocus: handleUrlFocus,
      },
      onSuggestionMouseDown: handleSuggestionMouseDown,
    }), [paneId, navigateTo, fireNavStateChange, openFindBar, startPicking, stopPicking, handleUrlChange, handleUrlKeyDown, handleUrlBlur, handleUrlFocus, handleSuggestionMouseDown]);

    const remoteHostIdRef = useRef(remoteHostId);
    remoteHostIdRef.current = remoteHostId;

    /** A remote pane's remembered box URL, which names its forwarded pages. */
    const rememberedRemoteUrl = () =>
      remoteHostId ? (shownUrlRef.current ?? selectPaneUrl(useAppStore.getState(), paneId)) : null;

    const answerDialog = (dialog: PageDialog, ok: boolean, text?: string) => {
      void window.electronAPI.webview.replyDialog(dialog.id, ok, text);
      setDialogs((open) => open.filter((d) => d.id !== dialog.id));
      // Back to the page, unless the user has moved on elsewhere in Manor.
      const active = document.activeElement;
      if (active && active.closest("[data-testid='page-dialog']")) webviewRef.current?.focus();
    };

    useMountEffect(() => {
      const wv = webviewRef.current;
      if (!wv) return;

      // A remembered (or agent-opened) `localhost:<port>` tab of a remote
      // workspace is loaded once main has resolved it against the host.
      remoteBrowserUrl.resolveInitialLoad();

      /** Record `shown` — the URL as the pane remembers it — as the page. */
      const applyNavigation = (shown: string, actual: string) => {
        const blank = shown === "about:blank";
        shownUrlRef.current = shown;
        setShownUrl(shown);
        setUrl(blank ? "" : shown);
        setIsBlank(blank);
        setPaneUrl(paneId, shown);
        updateNavState();
        clearPickedElement(paneId);
        const title = useAppStore.getState().paneTitle[paneId] ?? shown;
        useBrowserHistoryStore.getState().addEntry(shown, title);
        const isSecure = actual.startsWith("https://");
        fireNavStateChange({ url: blank ? "" : shown, isBlank: blank, isSecure });
      };

      const onNavigate = (e: Event) => remoteBrowserUrl.onNavigate(e, applyNavigation);

      const onTitleUpdate = (e: Event) => {
        setPaneTitle(paneId, (e as WebviewTitleEvent).title);
      };

      const onDidAttach = () => {
        const webContentsId = wv.getWebContentsId();
        // The host lets an agent's `navigate` reach the box's dev servers.
        window.electronAPI.webview.register(paneId, webContentsId, remoteHostIdRef.current);
      };

      wv.addEventListener("did-navigate", onNavigate);
      wv.addEventListener("did-navigate-in-page", onNavigate);
      wv.addEventListener("page-title-updated", onTitleUpdate);
      wv.addEventListener("did-attach", onDidAttach);
      // The guest reports it straight to its element; no trip through main.
      const onTargetUrl = (e: Event) => setTargetUrl((e as WebviewTargetUrlEvent).url);
      wv.addEventListener("update-target-url", onTargetUrl);

      const unsubDialog = window.electronAPI.webview.onDialog(
        (dialogPaneId: string, dialog: PageDialog) => {
          if (dialogPaneId !== paneId) return;
          setDialogs((open) => [...open, dialog]);
        },
      );
      const unsubDialogClosed = window.electronAPI.webview.onDialogClosed(
        (dialogPaneId: string, dialogId: string) => {
          if (dialogPaneId !== paneId) return;
          setDialogs((open) => open.filter((d) => d.id !== dialogId));
        },
      );

      const onWebviewFocus = () => fireNavStateChange({ webviewFocused: true });
      const onWebviewBlur = () => fireNavStateChange({ webviewFocused: false });
      wv.addEventListener("focus", onWebviewFocus);
      wv.addEventListener("blur", onWebviewBlur);

      const unsubEscape = window.electronAPI.webview.onEscape(
        (escapePaneId: string) => {
          if (escapePaneId !== paneId) return;
          wv.blur();
        },
      );

      const unsubFocusUrl = window.electronAPI.webview.onFocusUrl(
        (focusPaneId: string) => {
          if (focusPaneId !== paneId) return;
          wv.blur();
          const input = document.querySelector<HTMLInputElement>(
            `[data-pane-url-input="${paneId}"]`,
          );
          if (input) {
            input.focus();
            input.select();
          }
        },
      );

      const unsubNewWindow = window.electronAPI.webview.onNewWindow(
        (sourcePaneId: string, openUrl: string, opts?: { background?: boolean }) => {
          if (sourcePaneId !== paneId) return;
          useAppStore.getState().addBrowserTab(openUrl, { background: opts?.background });
        },
      );

      const unsubOpenInSplit = window.electronAPI.webview.onOpenInSplit(
        (sourcePaneId: string, openUrl: string) => {
          if (sourcePaneId !== paneId) return;
          // As the terminal's link menu does: beside a wide pane, under a tall one.
          useAppStore
            .getState()
            .splitPaneAt(paneId, splitDirectionBeside(containerRef.current), "second", {
              contentType: "browser",
              url: openUrl,
            });
        },
      );

      const unsubLoading = window.electronAPI.webview.onLoadingChanged(
        (loadPaneId: string, loading: boolean) => {
          if (loadPaneId !== paneId) return;
          setIsLoading(loading);
          fireNavStateChange({ isLoading: loading });
        },
      );

      const unsubFavicon = window.electronAPI.webview.onFaviconUpdated(
        (favPaneId: string, faviconUrl: string) => {
          if (favPaneId !== paneId) return;
          fireNavStateChange({ favicon: faviconUrl });
        },
      );

      const unsubAudioState = window.electronAPI.webview.onAudioStateChanged(
        (audioPaneId: string, audible: boolean) => {
          if (audioPaneId !== paneId) return;
          fireNavStateChange({ audible });
          useAppStore.getState().setPaneAudioPlaying(paneId, audible);
        },
      );

      const unsubFindResult = window.electronAPI.webview.onFindResult(
        (findPaneId: string, result: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => {
          if (findPaneId !== paneId) return;
          fireNavStateChange({ findActiveMatch: result.activeMatchOrdinal, findTotalMatches: result.matches });
        },
      );

      const unsubFind = window.electronAPI.webview.onFind(
        (findPaneId: string) => {
          if (findPaneId !== paneId) return;
          openFindBar();
        },
      );

      const unsubGoBack = window.electronAPI.webview.onGoBack(
        (navPaneId: string) => {
          if (navPaneId !== paneId) return;
          webviewRef.current?.goBack();
        },
      );

      const unsubGoForward = window.electronAPI.webview.onGoForward(
        (navPaneId: string) => {
          if (navPaneId !== paneId) return;
          webviewRef.current?.goForward();
        },
      );

      const unsubDevToolsChanged = window.electronAPI.webview.onDevToolsChanged(
        (devToolsPaneId: string, open: boolean) => {
          if (devToolsPaneId !== paneId) return;
          setDevToolsOpen(open);
          fireNavStateChange({ devToolsOpen: open });
        },
      );

      // ⌥⌘I pressed in the page itself.
      const unsubToggleDevTools = window.electronAPI.webview.onToggleDevTools(
        (devToolsPaneId: string) => {
          if (devToolsPaneId !== paneId) return;
          if (navStateRef.current.devToolsOpen) {
            void window.electronAPI.webview.closeDevTools(paneId);
          } else {
            void window.electronAPI.webview.openDevTools(paneId);
          }
        },
      );

      return () => {
        unsubDevToolsChanged();
        unsubToggleDevTools();
        wv.removeEventListener("did-navigate", onNavigate);
        wv.removeEventListener("did-navigate-in-page", onNavigate);
        wv.removeEventListener("page-title-updated", onTitleUpdate);
        wv.removeEventListener("did-attach", onDidAttach);
        wv.removeEventListener("update-target-url", onTargetUrl);
        wv.removeEventListener("focus", onWebviewFocus);
        wv.removeEventListener("blur", onWebviewBlur);
        window.electronAPI.webview.unregister(paneId);
        unsubDialog();
        unsubDialogClosed();
        unsubEscape();
        unsubFocusUrl();
        unsubNewWindow();
        unsubOpenInSplit();
        unsubLoading();
        unsubFavicon();
        unsubAudioState();
        unsubFindResult();
        unsubFind();
        unsubGoBack();
        unsubGoForward();
      };
    });

    return (
      <div
        ref={(el) => {
          // Open Link in Split picks its direction from this box's shape,
          // and the DevTools split sizes against it.
          containerRef.current = el;
          splitRef.current = el;
        }}
        className={`${styles.container} ${devToolsOpen && dockSide === "right" ? styles.containerDockRight : ""}`}
      >
        <div
          className={styles.webviewContainer}
          style={devToolsOpen ? { flex: `${1 - dockFractions[dockSide]} 1 0` } : undefined}
        >
          {isLoading && <div className={styles.loadingBar} />}
          <webview
            ref={webviewRef as React.RefObject<HTMLElement>}
            // A remote pane's src is the forwarded URL it loaded, never the
            // remembered box URL — that one would load on this machine.
            src={remoteBrowserUrl.src}
            // allowpopups (string attr — see WEBVIEW_ALLOW_POPUPS) lets guest
            // window.open / target=_blank reach the native setWindowOpenHandler
            // in electron/ipc/webview.ts; without it the open is blocked before
            // the handler ever runs.
            {...WEBVIEW_ALLOW_POPUPS}
          />
          <HostIndicator
            hostId={remoteHostId}
            variant="banner"
            projectId={projectId}
            blocksPointer
          />
          {remoteBrowserUrl.waiting ? (
            <div className={styles.emptyState}>
              Waiting for {remoteBrowserUrl.hostLabel ?? "the remote host"}…
            </div>
          ) : loadProblem.problem ? (
            <LoadProblemPage
              problem={loadProblem.problem}
              site={
                loadProblem.problem.kind === "crashed"
                  ? ""
                  : siteLabel(loadProblem.problem.url, rememberedRemoteUrl())
              }
              onRetry={loadProblem.retry}
              onCancel={loadProblem.cancelWait}
            />
          ) : (
            isBlank && <BlankPage workspaceKey={workspaceKey} onOpen={navigateTo} />
          )}
          {targetUrl && !loadProblem.problem && (
            <div className={styles.linkBubble} data-testid="browser-link-bubble">
              {targetUrl}
            </div>
          )}
          <PageNotesOverlay
            pageNotes={pageNotes}
            picking={picking}
            pageUrl={shownUrl}
            workspaceKey={workspaceKey}
            webviewRef={webviewRef}
          />
          {dialogs[0] && (
            <PageDialogOverlay
              key={dialogs[0].id}
              dialog={dialogs[0]}
              site={siteLabel(dialogs[0].origin, rememberedRemoteUrl())}
              onAnswer={(ok, text) => answerDialog(dialogs[0], ok, text)}
            />
          )}
          {(isDragActive || dockResizing) && <div className={styles.dragOverlay} />}
        </div>
        {devToolsOpen && (
          <DevToolsDock
            paneId={paneId}
            side={dockSide}
            fraction={dockFractions[dockSide]}
            splitRef={splitRef}
            onFractionChange={setDockFraction}
            onSideChange={setDockSide}
            onResizingChange={setDockResizing}
          />
        )}
      </div>
    );
  },
);
