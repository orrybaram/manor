import { useEffect, useRef, useState, useCallback } from "react";
import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";
import { useAppStore } from "../store/app-store";

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

export function BrowserPane({ paneId, initialUrl }: BrowserPaneProps) {
  const webviewRef = useRef<WebviewElement>(null);
  const [url, setUrl] = useState(initialUrl);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const setPaneTitle = useAppStore((s) => s.setPaneTitle);

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
    const wv = webviewRef.current;
    if (!wv) return;

    const onNavigate = (e: Event) => {
      setUrl((e as WebviewNavigateEvent).url);
      updateNavState();
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

    return () => {
      wv.removeEventListener("did-navigate", onNavigate);
      wv.removeEventListener("did-navigate-in-page", onNavigate);
      wv.removeEventListener("page-title-updated", onTitleUpdate);
      wv.removeEventListener("did-attach", onDidAttach);
      window.electronAPI.webview.unregister(paneId);
    };
  }, [paneId, setPaneTitle, updateNavState]);

  const handleBack = () => {
    webviewRef.current?.goBack();
  };

  const handleForward = () => {
    webviewRef.current?.goForward();
  };

  const handleReload = () => {
    webviewRef.current?.reload();
  };

  const handleUrlKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const wv = webviewRef.current;
      if (wv) {
        let target = url;
        if (!/^https?:\/\//i.test(target)) {
          target = `https://${target}`;
        }
        wv.src = target;
        setUrl(target);
      }
    }
  };

  return (
    <div className={styles.container}>
      <div
        className={`${styles.toolbar} ${isFocused ? styles.toolbarFocused : ""}`}
      >
        <button
          className={styles.navBtn}
          onClick={handleBack}
          disabled={!canGoBack}
          title="Back"
        >
          <ArrowLeft size={12} />
        </button>
        <button
          className={styles.navBtn}
          onClick={handleForward}
          disabled={!canGoForward}
          title="Forward"
        >
          <ArrowRight size={12} />
        </button>
        <button className={styles.navBtn} onClick={handleReload} title="Reload">
          <RotateCw size={12} />
        </button>
        <input
          className={styles.urlInput}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={handleUrlKeyDown}
          spellCheck={false}
        />
      </div>
      <div className={styles.webviewContainer}>
        <webview
          ref={webviewRef as React.RefObject<HTMLElement>}
          src={initialUrl}
        />
      </div>
    </div>
  );
}
