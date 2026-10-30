import { useState, type RefObject } from "react";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { ERR_ABORTED } from "../../../lib/browser-load-error";

/** What stands in for the page when it can't be shown. */
export type LoadProblem =
  /** A main-frame load failed; `name` is Chromium's (`ERR_NAME_NOT_RESOLVED`). */
  | { kind: "failed"; url: string; name: string }
  /** The page's renderer process died. */
  | { kind: "crashed" };

/** The `<webview>` methods and events this hook uses. */
export interface ProblemWebview extends HTMLElement {
  loadURL(url: string): Promise<void>;
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

export interface UseLoadProblemResult {
  problem: LoadProblem | null;
  /** Retry the failed load, or reload the crashed page. */
  retry: () => void;
}

/**
 * The pane's error and crash pages. A failed main-frame load (other than one
 * cut short by another) shows the error page until the next navigation
 * starts; a dead renderer shows the crash page until it is reloaded.
 */
export function useLoadProblem(webviewRef: RefObject<ProblemWebview | null>): UseLoadProblemResult {
  const [problem, setProblem] = useState<LoadProblem | null>(null);

  useMountEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;

    const onFailLoad = (e: Event) => {
      const fail = e as DidFailLoadEvent;
      if (!fail.isMainFrame || fail.errorCode === ERR_ABORTED) return;
      setProblem({ kind: "failed", url: fail.validatedURL, name: fail.errorDescription });
    };
    // A failed load's error page commits as part of the same navigation, so
    // a new one starting is always another attempt or another page.
    const onStartNavigation = (e: Event) => {
      const nav = e as DidStartNavigationEvent;
      if (nav.isMainFrame && !nav.isInPlace) setProblem(null);
    };
    const onGone = () => setProblem({ kind: "crashed" });

    wv.addEventListener("did-fail-load", onFailLoad);
    wv.addEventListener("did-start-navigation", onStartNavigation);
    wv.addEventListener("render-process-gone", onGone);
    return () => {
      wv.removeEventListener("did-fail-load", onFailLoad);
      wv.removeEventListener("did-start-navigation", onStartNavigation);
      wv.removeEventListener("render-process-gone", onGone);
    };
  });

  const retry = () => {
    const wv = webviewRef.current;
    if (!wv || !problem) return;
    setProblem(null);
    // A crashed guest comes back on a reload: Electron starts it a new
    // renderer process.
    if (problem.kind === "crashed") wv.reload();
    // Rejects when it fails again, which `did-fail-load` reports.
    else wv.loadURL(problem.url).catch(() => {});
  };

  return { problem, retry };
}
