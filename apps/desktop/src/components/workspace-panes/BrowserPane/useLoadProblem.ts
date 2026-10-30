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
   * `attempt` is due at `retryAt`. `name` is how the last attempt failed.
   */
  | {
      kind: "waiting";
      url: string;
      name: string;
      attempt: number;
      retryAt: number;
      startedAt: number;
    };

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
 * page loads, the pane goes somewhere else, or the wait runs out. A remote
 * pane (`isRemote`) reaches the box's dev servers through a port forward,
 * which reports a refusal its own ways (`waitsForDevServer`).
 */
export function useLoadProblem(
  paneId: string,
  webviewRef: RefObject<ProblemWebview | null>,
  /** Told of each problem as it is shown. */
  onProblem?: (problem: LoadProblem) => void,
  /** Whether the pane's workspace is on a remote host, read at each failure. */
  isRemote: () => boolean = () => false,
): UseLoadProblemResult {
  const [problem, setProblemState] = useState<LoadProblem | null>(null);
  const problemRef = useRef(problem);
  const onProblemRef = useRef(onProblem);
  onProblemRef.current = onProblem;
  const isRemoteRef = useRef(isRemote);
  isRemoteRef.current = isRemote;
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The URL of the retry this hook last loaded, until its navigation ends. */
  const retryingRef = useRef<string | null>(null);
  /**
   * The URL whose wait the user cancelled: a refusal of a retry already on
   * its way leaves the error page up rather than start the wait again.
   */
  const cancelledRef = useRef<string | null>(null);

  const setProblem = (next: LoadProblem | null) => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    problemRef.current = next;
    setProblemState(next);
    if (next) onProblemRef.current?.(next);
  };

  // Main drops it if the pane has gone elsewhere by the time it arrives.
  const load = (url: string) => {
    retryingRef.current = url;
    void window.electronAPI.webview.loadUrl(paneId, url);
  };

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
    setProblem({ kind: "waiting", url, name, attempt, retryAt: now + delay, startedAt });
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
      retryingRef.current = null;
      if (waitsForDevServer(fail.validatedURL, fail.errorCode, isRemoteRef.current())) {
        if (cancelledRef.current === fail.validatedURL) {
          setProblem({ kind: "failed", url: fail.validatedURL, name: fail.errorDescription });
        } else {
          waitFor(fail.validatedURL, fail.errorDescription);
        }
      } else {
        setProblem({ kind: "failed", url: fail.validatedURL, name: fail.errorDescription });
      }
    };
    // A failed load never commits, so a new navigation starting is always
    // another attempt or another page: only the wait's own retry keeps it
    // (and the error page it was cancelled to, if it lands after the Cancel).
    const onStartNavigation = (e: Event) => {
      const nav = e as DidStartNavigationEvent;
      if (!nav.isMainFrame || nav.isInPlace) return;
      const current = problemRef.current;
      if (nav.url === retryingRef.current) return;
      if (current?.kind === "waiting" && current.url === nav.url) return;
      retryingRef.current = null;
      cancelledRef.current = null;
      if (current) setProblem(null);
    };
    // A page committed: whatever stood in for it is over.
    const onNavigate = (e: Event) => {
      if ((e as DidNavigateEvent).isMainFrame === false) return;
      retryingRef.current = null;
      cancelledRef.current = null;
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
    cancelledRef.current = null;
    setProblem(null);
    // A crashed guest comes back on a reload: Electron starts it a new
    // renderer process.
    if (current.kind === "crashed") wv.reload();
    else load(current.url);
  };

  const cancelWait = () => {
    const current = problemRef.current;
    if (current?.kind !== "waiting") return;
    cancelledRef.current = current.url;
    setProblem({ kind: "failed", url: current.url, name: current.name });
  };

  return { problem, retry, cancelWait };
}
