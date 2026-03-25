import { useEffect, useRef, useState, useCallback } from "react";
import { ArrowLeft, ArrowRight, RotateCw, Crosshair } from "lucide-react";
import { useAppStore } from "../store/app-store";
import { useToastStore } from "../store/toast-store";
import { useBrowserHistoryStore, type HistoryEntry } from "../store/browser-history-store";
import type { PickedElementResult } from "../electron.d";

import { Tooltip } from "./Tooltip";
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

interface BrowserPaneProps {
  paneId: string;
  initialUrl: string;
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

export function BrowserPane({ paneId, initialUrl }: BrowserPaneProps) {
  const webviewRef = useRef<WebviewElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(initialUrl);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [pickerActive, setPickerActive] = useState(false);

  const [isBlank, setIsBlank] = useState(initialUrl === "about:blank");
  const [suggestions, setSuggestions] = useState<HistoryEntry[]>([]);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setPaneTitle = useAppStore((s) => s.setPaneTitle);
  const setPaneUrl = useAppStore((s) => s.setPaneUrl);
  const setPickedElement = useAppStore((s) => s.setPickedElement);
  const clearPickedElement = useAppStore((s) => s.clearPickedElement);

  const focusedPaneId = useAppStore((s) => {
    const wsId = s.selectedWorkspaceId;
    if (!wsId) return null;
    const wss = s.workspaceSessions[wsId];
    if (!wss) return null;
    const session = wss.sessions.find((t) => t.id === wss.selectedSessionId);
    return session?.focusedPaneId ?? null;
  });
  const isFocused = focusedPaneId === paneId;

  const updateNavState = useCallback(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    try {
      setCanGoBack(wv.canGoBack());
      setCanGoForward(wv.canGoForward());
    } catch {
      // webview not ready yet
    }
  }, []);

  useEffect(() => {
    if (isBlank) {
      setUrl("");
      urlInputRef.current?.focus();
    }
  }, [isBlank]);

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;

    const onNavigate = (e: Event) => {
      const newUrl = (e as WebviewNavigateEvent).url;
      setUrl(newUrl);
      setIsBlank(newUrl === "about:blank");
      setPaneUrl(paneId, newUrl);
      updateNavState();
      clearPickedElement(paneId);
      const title = useAppStore.getState().paneTitle[paneId] ?? newUrl;
      useBrowserHistoryStore.getState().addEntry(newUrl, title);
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
        setPickerActive(false);
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
        setPickerActive(false);
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
  }, [paneId, setPaneTitle, updateNavState, setPickedElement, clearPickedElement]);

  const handleBack = () => {
    webviewRef.current?.goBack();
  };

  const handleForward = () => {
    webviewRef.current?.goForward();
  };

  const handleReload = () => {
    webviewRef.current?.reload();
  };

  const handlePickElement = () => {
    if (pickerActive) return;
    setPickerActive(true);
    window.electronAPI.webview.startPicker(paneId);
  };

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
  }, []);

  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setUrl(value);
    const results = useBrowserHistoryStore.getState().search(value);
    setSuggestions(results);
    setHighlightIndex(-1);
  };

  const handleUrlKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((prev) =>
        suggestions.length === 0 ? -1 : Math.min(prev + 1, suggestions.length - 1)
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((prev) => Math.max(prev - 1, -1));
    } else if (e.key === "Escape") {
      setSuggestions([]);
      setHighlightIndex(-1);
    } else if (e.key === "Enter") {
      if (highlightIndex >= 0 && suggestions[highlightIndex]) {
        navigateTo(suggestions[highlightIndex].url);
      } else {
        navigateTo(url);
      }
    }
  };

  const handleUrlBlur = () => {
    blurTimerRef.current = setTimeout(() => {
      setSuggestions([]);
      setHighlightIndex(-1);
    }, 150);
  };

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
      <div
        className={`${styles.toolbar} ${isFocused ? styles.toolbarFocused : ""}`}
      >
        <Tooltip label="Back">
          <button
            className={styles.navBtn}
            onClick={handleBack}
            disabled={!canGoBack}
          >
            <ArrowLeft size={12} />
          </button>
        </Tooltip>
        <Tooltip label="Forward">
          <button
            className={styles.navBtn}
            onClick={handleForward}
            disabled={!canGoForward}
          >
            <ArrowRight size={12} />
          </button>
        </Tooltip>
        <Tooltip label="Reload">
          <button className={styles.navBtn} onClick={handleReload}>
            <RotateCw size={12} />
          </button>
        </Tooltip>
        <div className={styles.urlWrapper}>
          <input
            ref={urlInputRef}
            className={styles.urlInput}
            value={url}
            onChange={handleUrlChange}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={handleUrlKeyDown}
            onBlur={handleUrlBlur}
            spellCheck={false}
          />
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
        </div>
        <Tooltip label="Pick Element">
          <button
            className={`${styles.navBtn} ${pickerActive ? styles.navBtnActive : ""}`}
            onClick={handlePickElement}
            disabled={pickerActive}
          >
            <Crosshair size={12} />
          </button>
        </Tooltip>
      </div>
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
}
