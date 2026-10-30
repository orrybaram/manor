import { useRef, useState, type RefObject } from "react";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { ERR_ABORTED } from "../../../lib/browser-load-error";
import { retryDelay, waitsForDevServer } from "../../../lib/dev-server-wait";

/** What stands in for the page when it can't be shown. */
export type LoadProblem =
  /** A main-frame load failed; `name` is Chromium's (`ERR_NAME_NOT_RESOLVED`). */
  | { kind: "failed"; url: string; name: string }
  /** The page's renderer process died. */
  | { kind: "crashed" }
  /**
   * Nothing listens yet on the loopback port `url` loads from: retry
   * `attempt` is due at `retryAt`.
   */
  | { kind: "waiting"; url: string; attempt: number; retryAt: number; startedAt: number };

/** The `<webview>` methods and events this hook uses. */
export interface ProblemWebview extends HTMLElement {
  reload(): void;
}

interface DidFailLoadEvent extends Event {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  isMainFrame: boolean;
}

interface DidStartNavigationEvent extends Event {
  url: string;
  isInPlace: boolean;
  isMainFrame: boolean;
}

interface DidNavigateEvent extends Event {
  isMainFrame?: boolean;
}

export interface UseLoadProblemResult {
  problem: LoadProblem | null;
  /** Retry the failed load, reload the crashed page, or retry the wait now. */
  retry: () => void;
  /** Stop waiting for the dev server and show the error page. */
  cancelWait: () => void;
}

/**
 * The pane's error, crash and waiting pages.
 *
 * A failed main-frame load (other than one cut short by another) shows the
 * error page until the next navigation starts; a dead renderer shows the
 * crash page until it is reloaded. A refused load of a loopback dev server
 * instead waits for it, retrying on `dev-server-wait`'s backoff, until a
 * page loads, the pane goes somewhere else, or the wait runs out.
 */
export function useLoadProblem(
  paneId: string,
  webviewRef: RefObject<ProblemWebview | null>,
): UseLoadProblemResult {
  const [problem, setProblemState] = useState<LoadProblem | null>(null);
  const problemRef = useRef(problem);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setProblem = (next: LoadProblem | null) => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    problemRef.current = next;
    setProblemState(next);
  };

  const load = (url: string) => void window.electronAPI.webview.loadUrl(paneId, url);

  /** Wait for the dev server at `url`: the next retry, or the error page once the wait is over. */
  const waitFor = (url: string, name: string) => {
    const now = Date.now();
    const prev = problemRef.current;
    const ongoing = prev?.kind === "waiting" && prev.url === url ? prev : null;
    const startedAt = ongoing?.startedAt ?? now;
    const attempt = ongoing ? ongoing.attempt + 1 : 1;
    const delay = retryDelay(attempt, now - startedAt);
    if (delay === null) {
      setProblem({ kind: "failed", url, name });
      return;
    }
    setProblem({ kind: "waiting", url, attempt, retryAt: now + delay, startedAt });
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      load(url);
    }, delay);
  };

  useMountEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;

    const onFailLoad = (e: Event) => {
      const fail = e as DidFailLoadEvent;
      if (!fail.isMainFrame || fail.errorCode === ERR_ABORTED) return;
      if (waitsForDevServer(fail.validatedURL, fail.errorCode)) {
        waitFor(fail.validatedURL, fail.errorDescription);
      } else {
        setProblem({ kind: "failed", url: fail.validatedURL, name: fail.errorDescription });
      }
    };
    // A failed load never commits, so a new navigation starting is always
    // another attempt or another page: only the wait's own retry keeps it.
    const onStartNavigation = (e: Event) => {
      const nav = e as DidStartNavigationEvent;
      if (!nav.isMainFrame || nav.isInPlace) return;
      const current = problemRef.current;
      if (current?.kind === "waiting" && current.url === nav.url) return;
      if (current) setProblem(null);
    };
    // A page committed: whatever stood in for it is over.
    const onNavigate = (e: Event) => {
      if ((e as DidNavigateEvent).isMainFrame === false) return;
      if (problemRef.current) setProblem(null);
    };
    const onGone = () => setProblem({ kind: "crashed" });

    wv.addEventListener("did-fail-load", onFailLoad);
    wv.addEventListener("did-start-navigation", onStartNavigation);
    wv.addEventListener("did-navigate", onNavigate);
    wv.addEventListener("render-process-gone", onGone);
    return () => {
      wv.removeEventListener("did-fail-load", onFailLoad);
      wv.removeEventListener("did-start-navigation", onStartNavigation);
      wv.removeEventListener("did-navigate", onNavigate);
      wv.removeEventListener("render-process-gone", onGone);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  });

  const retry = () => {
    const current = problemRef.current;
    const wv = webviewRef.current;
    if (!wv || !current) return;
    if (current.kind === "waiting") {
      // Now rather than at `retryAt`; a refusal carries on the same wait.
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      load(current.url);
      return;
    }
    setProblem(null);
    // A crashed guest comes back on a reload: Electron starts it a new
    // renderer process.
    if (current.kind === "crashed") wv.reload();
    else load(current.url);
  };

  const cancelWait = () => {
    const current = problemRef.current;
    if (current?.kind !== "waiting") return;
    setProblem({ kind: "failed", url: current.url, name: "ERR_CONNECTION_REFUSED" });
  };

  return { problem, retry, cancelWait };
}
