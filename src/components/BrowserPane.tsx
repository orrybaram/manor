import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { useAppStore } from "../store/app-store";
import { useToastStore } from "../store/toast-store";
import { useBrowserHistoryStore, type HistoryEntry } from "../store/browser-history-store";
import type { PickedElementResult } from "../electron.d";

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
}

interface WebviewTitleEvent extends Event {
  title: string;
}

export interface BrowserPaneNavState {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  pickerActive: boolean;
  isBlank: boolean;
}

export interface BrowserPaneRef {
  goBack(): void;
  goForward(): void;
  reload(): void;
  startPicker(): void;
  navigate(url: string): void;
  focusUrlInput(): void;
  /** Current value of the URL input (controlled by BrowserPane). */
  getUrlInputValue(): string;
  /** Handlers for the URL input element rendered by LeafPane. */
  urlInputHandlers: {
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    onBlur: () => void;
    onFocus: (e: React.FocusEvent<HTMLInputElement>) => void;
  };
}

interface BrowserPaneProps {
  paneId: string;
  initialUrl: string;
  onNavStateChange?: (state: BrowserPaneNavState) => void;
}

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

export const BrowserPane = forwardRef<BrowserPaneRef, BrowserPaneProps>(
  function BrowserPane({ paneId, initialUrl, onNavStateChange }, ref) {
    const webviewRef = useRef<WebviewElement>(null);
    const [url, setUrl] = useState(initialUrl === "about:blank" ? "" : initialUrl);
    const [isBlank, setIsBlank] = useState(initialUrl === "about:blank");
    const [suggestions, setSuggestions] = useState<HistoryEntry[]>([]);
    const [highlightIndex, setHighlightIndex] = useState(-1);
    const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    });

    const onNavStateChangeRef = useRef(onNavStateChange);
    useEffect(() => {
      onNavStateChangeRef.current = onNavStateChange;
    }, [onNavStateChange]);

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

    const navigateTo = useCallback((target: string) => {
      const wv = webviewRef.current;
      if (!wv) return;
      let resolved = target;
      if (!/^https?:\/\//i.test(resolved)) {
        resolved = `https://${resolved}`;
      }
      wv.src = resolved;
      setUrl(resolved);
      setSuggestions([]);
      setHighlightIndex(-1);
      fireNavStateChange({ url: resolved });
    }, [fireNavStateChange]);

    // URL input handlers — kept here so url/nav state management stays in BrowserPane.
    // LeafPane will render the actual <input> and wire these up via the ref (ticket 2).
    const handleUrlChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setUrl(value);
      const results = useBrowserHistoryStore.getState().search(value);
      setSuggestions(results);
      setHighlightIndex(-1);
    }, []);

    const urlRef = useRef(url);
    useEffect(() => {
      urlRef.current = url;
    }, [url]);

    const suggestionsRef = useRef(suggestions);
    useEffect(() => {
      suggestionsRef.current = suggestions;
    }, [suggestions]);

    const highlightIndexRef = useRef(highlightIndex);
    useEffect(() => {
      highlightIndexRef.current = highlightIndex;
    }, [highlightIndex]);

    const handleUrlKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
      const currentSuggestions = suggestionsRef.current;
      const currentHighlight = highlightIndexRef.current;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIndex((prev) =>
          currentSuggestions.length === 0 ? -1 : Math.min(prev + 1, currentSuggestions.length - 1)
        );
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIndex((prev) => Math.max(prev - 1, -1));
      } else if (e.key === "Escape") {
        setSuggestions([]);
        setHighlightIndex(-1);
      } else if (e.key === "Enter") {
        if (currentHighlight >= 0 && currentSuggestions[currentHighlight]) {
          navigateTo(currentSuggestions[currentHighlight].url);
        } else {
          navigateTo(urlRef.current);
        }
      }
    }, [navigateTo]);

    const handleUrlBlur = useCallback(() => {
      blurTimerRef.current = setTimeout(() => {
        setSuggestions([]);
        setHighlightIndex(-1);
      }, 150);
    }, []);

    const handleUrlFocus = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
      e.currentTarget.select();
    }, []);

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
      startPicker() {
        if (navStateRef.current.pickerActive) return;
        fireNavStateChange({ pickerActive: true });
        window.electronAPI.webview.startPicker(paneId);
      },
      navigate(target: string) {
        navigateTo(target);
      },
      focusUrlInput() {
        // URL input is rendered by LeafPane; no-op placeholder
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
    }), [paneId, navigateTo, fireNavStateChange, handleUrlChange, handleUrlKeyDown, handleUrlBlur, handleUrlFocus]);

    useEffect(() => {
      const wv = webviewRef.current;
      if (!wv) return;

      const onNavigate = (e: Event) => {
        const newUrl = (e as WebviewNavigateEvent).url;
        const blank = newUrl === "about:blank";
        setUrl(blank ? "" : newUrl);
        setIsBlank(blank);
        setPaneUrl(paneId, newUrl);
        updateNavState();
        clearPickedElement(paneId);
        const title = useAppStore.getState().paneTitle[paneId] ?? newUrl;
        useBrowserHistoryStore.getState().addEntry(newUrl, title);
        fireNavStateChange({ url: blank ? "" : newUrl, isBlank: blank });
      };

      const onTitleUpdate = (e: Event) => {
        setPaneTitle(paneId, (e as WebviewTitleEvent).title);
      };

      const onDidAttach = () => {
        const webContentsId = wv.getWebContentsId();
        window.electronAPI.webview.register(paneId, webContentsId);
      };

      wv.addEventListener("did-navigate", onNavigate);
      wv.addEventListener("did-navigate-in-page", onNavigate);
      wv.addEventListener("page-title-updated", onTitleUpdate);
      wv.addEventListener("did-attach", onDidAttach);

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

      return () => {
        wv.removeEventListener("did-navigate", onNavigate);
        wv.removeEventListener("did-navigate-in-page", onNavigate);
        wv.removeEventListener("page-title-updated", onTitleUpdate);
        wv.removeEventListener("did-attach", onDidAttach);
        window.electronAPI.webview.unregister(paneId);
        unsubPickerResult();
        unsubPickerCancel();
      };
    }, [paneId, setPaneTitle, updateNavState, setPickedElement, clearPickedElement, fireNavStateChange]);

    const handleSuggestionMouseDown = (entry: HistoryEntry) => {
      // Cancel the blur timer so dropdown doesn't close before click registers
      if (blurTimerRef.current) {
        clearTimeout(blurTimerRef.current);
        blurTimerRef.current = null;
      }
      navigateTo(entry.url);
    };

    return (
      <div className={styles.container}>
        {suggestions.length > 0 && (
          <div className={styles.autocompleteDropdown}>
            {suggestions.map((entry, idx) => (
              <div
                key={entry.url}
                className={`${styles.autocompleteItem} ${idx === highlightIndex ? styles.autocompleteItemHighlighted : ""}`}
                onMouseDown={() => handleSuggestionMouseDown(entry)}
              >
                <span className={styles.autocompleteTitle}>{entry.title || entry.url}</span>
                <span className={styles.autocompleteUrl}>{entry.url}</span>
              </div>
            ))}
          </div>
        )}
        <div className={styles.webviewContainer}>
          <webview
            ref={webviewRef as React.RefObject<HTMLElement>}
            src={initialUrl}
          />
          {isBlank && (
            <div className={styles.emptyState}>Enter a URL to get started</div>
          )}
        </div>
      </div>
    );
  },
);
