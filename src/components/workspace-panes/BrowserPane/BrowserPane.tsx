import { useRef, useState, useCallback, useEffect, forwardRef, useImperativeHandle } from "react";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { useAppStore } from "../../../store/app-store";
import { useToastStore } from "../../../store/toast-store";
import { useBrowserHistoryStore, type HistoryEntry } from "../../../store/browser-history-store";
import { useDragOverlayStore, selectIsDragActive } from "../../../store/drag-overlay-store";
import type { PickedElementResult } from "../../../electron.d";
import { onUiRequest } from "../../../utils/ui-request";
import { isLocalhostHttpUrl } from "../../../lib/hosts";
import { useHostStore } from "../../../store/host-store";

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

interface WebviewNavigateEvent extends Event {
  url: string;
  isMainFrame: boolean;
}

interface WebviewTitleEvent extends Event {
  title: string;
}

/** Electron <webview> dialog event — returnValue must be set synchronously. */
type WebviewDialogEvent = Event & {
  readonly url: string;
  readonly message: string;
  readonly defaultPromptText: string;
  readonly dialogType: "alert" | "confirm" | "prompt";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  returnValue: any;
};

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
}

export interface BrowserPaneRef {
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  startPicker(): void;
  cancelPicker(): void;
  navigate(url: string): void;
  focusUrlInput(): void;
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
  findInPage(query: string, options?: { forward?: boolean; findNext?: boolean }): void;
  stopFind(): void;
  toggleFindBar(): void;
  toggleMute(): void;
  /** Stop this pane's active recording (ADR-158), if any. */
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
   * through a port forward (ADR-178 §5).
   */
  remoteHostId?: string | null;
  onNavStateChange?: (state: BrowserPaneNavState) => void;
};

function formatPickedElement(result: PickedElementResult): string {
  const sections: string[] = [];

  if (result.reactComponents && result.reactComponents.length > 0) {
    const lines = result.reactComponents.map((c) => {
      if (c.source) {
        return `  in ${c.name} (at ${c.source.fileName}:${c.source.lineNumber})`;
      }
      return `  in ${c.name}`;
    });
    sections.push(`## React Context\n${lines.join("\n")}`);
  }

  sections.push(`## Selector\n${result.selector}`);
  sections.push(`## HTML\n${result.outerHTML}`);

  return sections.join("\n\n");
}

// React 19 silently drops a boolean `allowpopups={true}` on <webview>, leaving
// the attribute absent — which makes Electron block all guest window.open /
// target=_blank before they reach setWindowOpenHandler. Emit it as a string
// attribute instead (Electron only checks for presence). Spread to bypass the
// boolean prop type in React's WebViewHTMLAttributes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WEBVIEW_ALLOW_POPUPS: any = { allowpopups: "true" };

/** Whether two URLs point at the same host and port. */
function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return a === b;
  }
}

export const BrowserPane = forwardRef<BrowserPaneRef, BrowserPaneProps>(
  function BrowserPane(props: BrowserPaneProps, ref) {
    const { paneId, initialUrl, remoteHostId = null, onNavStateChange } = props;
    const remoteHostIdRef = useRef(remoteHostId);
    remoteHostIdRef.current = remoteHostId;

    // ── Remote panes (ADR-178 §5) ──
    //
    // A pane of a remote workspace remembers and shows the box's own URL
    // (`localhost:<remote port>`) but loads it through a port forward
    // (`127.0.0.1:<local port>`), which only exists while the host is
    // connected and whose local port may change. So a remote pane's webview
    // `src` follows the URL actually loaded, never the remembered one, and
    // a remembered loopback URL is not loaded until main has resolved it
    // against the connected host — a "waiting for host" state until then,
    // rather than a load of the same port on this machine.
    const [deferInitialLoad] = useState(
      () => remoteHostId !== null && isLocalhostHttpUrl(initialUrl),
    );
    const [loadedUrl, setLoadedUrl] = useState(deferInitialLoad ? "about:blank" : initialUrl);
    const loadedUrlRef = useRef(loadedUrl);
    loadedUrlRef.current = loadedUrl;
    const [waitingForHost, setWaitingForHost] = useState(deferInitialLoad);
    const waitingForHostRef = useRef(waitingForHost);
    waitingForHostRef.current = waitingForHost;
    /** Bumped per remote resolve; a stale answer is dropped. */
    const resolveSeqRef = useRef(0);
    /** Bumped per navigation; a stale remote-URL lookup is dropped. */
    const navSeqRef = useRef(0);
    const hostStatus = useHostStore((s) =>
      remoteHostId ? (s.hosts.find((h) => h.hostId === remoteHostId)?.status ?? null) : null,
    );
    const hostLabel = useHostStore((s) =>
      remoteHostId
        ? (s.hosts.find((h) => h.hostId === remoteHostId)?.spec?.target ?? remoteHostId)
        : null,
    );

    const webviewRef = useRef<WebviewElement>(null);
    const [url, setUrl] = useState(initialUrl === "about:blank" ? "" : initialUrl);
    const [isBlank, setIsBlank] = useState(initialUrl === "about:blank");
    const [isLoading, setIsLoading] = useState(false);
    const [suggestions, setSuggestions] = useState<HistoryEntry[]>([]);
    const [highlightIndex, setHighlightIndex] = useState(-1);
    const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const isDragActive = useDragOverlayStore(selectIsDragActive);

    const setPaneTitle = useAppStore((s) => s.setPaneTitle);
    const setPaneUrl = useAppStore((s) => s.setPaneUrl);
    const setPickedElement = useAppStore((s) => s.setPickedElement);
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
    });

    const onNavStateChangeRef = useRef(onNavStateChange);
    onNavStateChangeRef.current = onNavStateChange;

    const fireNavStateChange = useCallback((overrides: Partial<BrowserPaneNavState>) => {
      navStateRef.current = { ...navStateRef.current, ...overrides };
      onNavStateChangeRef.current?.(navStateRef.current);
    }, []);

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

    /**
     * Load `remoteUrl` — the box's own `localhost:<port>` URL — through its
     * port forward, once main has one; the pane waits for the host until
     * then. The URL bar keeps showing `remoteUrl`.
     */
    const resolveRemote = useCallback((remoteUrl: string) => {
      const hostId = remoteHostIdRef.current;
      if (!hostId) return;
      const seq = ++resolveSeqRef.current;
      setWaitingForHost(true);
      const load = (target: string) => {
        if (seq !== resolveSeqRef.current) return;
        setWaitingForHost(false);
        const wv = webviewRef.current;
        if (!wv) return;
        wv.src = target;
        setLoadedUrl(target);
      };
      window.electronAPI.ports.resolveUrl(remoteUrl, hostId).then(load, () => load(remoteUrl));
    }, []);

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
      if (remoteHostIdRef.current && isLocalhostHttpUrl(resolved)) {
        setUrl(resolved);
        fireNavStateChange({ url: resolved, suggestions: [], highlightIndex: -1 });
        resolveRemote(resolved);
        return;
      }
      resolveSeqRef.current++; // a pending remote resolve is superseded
      setWaitingForHost(false);
      wv.src = resolved;
      if (remoteHostIdRef.current) setLoadedUrl(resolved);
      setUrl(resolved);
      fireNavStateChange({ url: resolved, suggestions: [], highlightIndex: -1 });
    }, [fireNavStateChange, resolveRemote]);

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
    // Find… (ADR-170) targeting this pane by id.
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
        if (navStateRef.current.pickerActive) return;
        fireNavStateChange({ pickerActive: true });
        window.electronAPI.webview.startPicker(paneId);
      },
      cancelPicker() {
        if (!navStateRef.current.pickerActive) return;
        window.electronAPI.webview.cancelPicker(paneId);
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
    }), [paneId, navigateTo, fireNavStateChange, openFindBar, handleUrlChange, handleUrlKeyDown, handleUrlBlur, handleUrlFocus, handleSuggestionMouseDown]);

    // A remote pane's forward dies with its host's connection, and may come
    // back on another local port: once the host is connected again, the
    // page is re-resolved and moved if its forward moved.
    const prevHostStatusRef = useRef(hostStatus);
    useEffect(() => {
      const prev = prevHostStatusRef.current;
      prevHostStatusRef.current = hostStatus;
      if (hostStatus !== "connected" || prev === "connected" || prev === null) return;
      if (waitingForHostRef.current) return; // main is already waiting on it
      const hostId = remoteHostIdRef.current;
      const remembered = useAppStore.getState().paneUrl[paneId];
      if (!hostId || !remembered || !isLocalhostHttpUrl(remembered)) return;
      const seq = ++resolveSeqRef.current;
      window.electronAPI.ports.resolveUrl(remembered, hostId).then(
        (target) => {
          if (seq !== resolveSeqRef.current) return;
          const wv = webviewRef.current;
          if (!wv || sameHost(target, loadedUrlRef.current)) return;
          wv.src = target;
          setLoadedUrl(target);
        },
        () => {},
      );
    }, [hostStatus, paneId]);

    useMountEffect(() => {
      const wv = webviewRef.current;
      if (!wv) return;

      // A remembered (or agent-opened) `localhost:<port>` tab of a remote
      // workspace is loaded once main has resolved it against the host.
      let skipBlank = deferInitialLoad;
      if (deferInitialLoad) resolveRemote(initialUrl);

      /** Record `shown` — the URL as the pane remembers it — as the page. */
      const applyNavigation = (shown: string, actual: string) => {
        const blank = shown === "about:blank";
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

      const onNavigate = (e: Event) => {
        const nav = e as WebviewNavigateEvent;
        if (nav.isMainFrame === false) return;
        const newUrl = nav.url;
        const seq = ++navSeqRef.current;
        const hostId = remoteHostIdRef.current;
        if (!hostId) {
          applyNavigation(newUrl, newUrl);
          return;
        }
        // The placeholder a deferred remote tab sits on is not a page.
        if (newUrl === "about:blank" && skipBlank) return;
        skipBlank = false;
        setLoadedUrl(newUrl);
        if (!isLocalhostHttpUrl(newUrl)) {
          applyNavigation(newUrl, newUrl);
          return;
        }
        // Remember the box's URL, not the forward's: it outlives the forward.
        window.electronAPI.ports.remoteUrl(newUrl, hostId).then(
          (shown) => {
            if (seq === navSeqRef.current) applyNavigation(shown, newUrl);
          },
          () => {
            if (seq === navSeqRef.current) applyNavigation(newUrl, newUrl);
          },
        );
      };

      const onTitleUpdate = (e: Event) => {
        setPaneTitle(paneId, (e as WebviewTitleEvent).title);
      };

      const onDidAttach = () => {
        const webContentsId = wv.getWebContentsId();
        // The host lets an agent's `navigate` reach the box's dev servers.
        window.electronAPI.webview.register(paneId, webContentsId, remoteHostIdRef.current);
      };

      // Handle JavaScript dialogs (alert, confirm, prompt) from the guest page.
      // Without this handler Electron silently dismisses them.
      const onDialog = (e: Event) => {
        const de = e as WebviewDialogEvent;
        if (de.dialogType === "alert") {
          window.alert(de.message);
          de.returnValue = { action: "accept" };
        } else if (de.dialogType === "confirm") {
          const ok = window.confirm(de.message);
          de.returnValue = { action: ok ? "accept" : "dismiss" };
        } else if (de.dialogType === "prompt") {
          const result = window.prompt(de.message, de.defaultPromptText);
          de.returnValue =
            result !== null
              ? { action: "accept", text: result }
              : { action: "dismiss" };
        }
      };

      wv.addEventListener("did-navigate", onNavigate);
      wv.addEventListener("did-navigate-in-page", onNavigate);
      wv.addEventListener("page-title-updated", onTitleUpdate);
      wv.addEventListener("did-attach", onDidAttach);
      wv.addEventListener("dialog", onDialog);

      const unsubPickerResult = window.electronAPI.webview.onPickerResult(
        (resultPaneId: string, result: PickedElementResult) => {
          if (resultPaneId !== paneId) return;
          fireNavStateChange({ pickerActive: false });
          setPickedElement(paneId, result);
          window.electronAPI.clipboard.writeText(formatPickedElement(result));
          useToastStore.getState().addToast({
            id: "picker-copied",
            message: "Element copied to clipboard",
            status: "success",
          });
        },
      );

      const unsubPickerCancel = window.electronAPI.webview.onPickerCancel(
        (cancelPaneId: string) => {
          if (cancelPaneId !== paneId) return;
          fireNavStateChange({ pickerActive: false });
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

      return () => {
        resolveSeqRef.current++;
        navSeqRef.current++;
        wv.removeEventListener("did-navigate", onNavigate);
        wv.removeEventListener("did-navigate-in-page", onNavigate);
        wv.removeEventListener("page-title-updated", onTitleUpdate);
        wv.removeEventListener("did-attach", onDidAttach);
        wv.removeEventListener("dialog", onDialog);
        wv.removeEventListener("focus", onWebviewFocus);
        wv.removeEventListener("blur", onWebviewBlur);
        window.electronAPI.webview.unregister(paneId);
        unsubPickerResult();
        unsubPickerCancel();
        unsubEscape();
        unsubFocusUrl();
        unsubNewWindow();
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
      <div className={styles.container}>
        <div className={styles.webviewContainer}>
          {isLoading && <div className={styles.loadingBar} />}
          <webview
            ref={webviewRef as React.RefObject<HTMLElement>}
            // A remote pane's src is the forwarded URL it loaded, never the
            // remembered box URL — that one would load on this machine.
            src={remoteHostId ? loadedUrl : initialUrl}
            // allowpopups (string attr — see WEBVIEW_ALLOW_POPUPS) lets guest
            // window.open / target=_blank reach the native setWindowOpenHandler
            // in electron/ipc/webview.ts; without it the open is blocked before
            // the handler ever runs.
            {...WEBVIEW_ALLOW_POPUPS}
          />
          {waitingForHost ? (
            <div className={styles.emptyState}>
              Waiting for {hostLabel ?? "the remote host"}…
            </div>
          ) : (
            isBlank && <div className={styles.emptyState}>Enter a URL to get started</div>
          )}
          {isDragActive && <div className={styles.dragOverlay} />}
        </div>
      </div>
    );
  },
);
