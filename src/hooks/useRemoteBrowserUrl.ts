import { useEffect, useRef, useState, type RefObject } from "react";
import { selectPaneUrl, useAppStore } from "../store/app-store";
import { useHostStore, selectHost } from "../store/host-store";
import { isLocalhostHttpUrl, resolveUrlForHost } from "../lib/hosts";
import { useHostDisplay } from "./useHostDisplay";
import { useMountEffect } from "./useMountEffect";

/** Whether two URLs point at the same host and port. */
function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return a === b;
  }
}

/** Anything with a settable `src`, so tests don't need a real `<webview>`. */
interface SrcElement {
  src: string;
}

export type ApplyNavigation = (shown: string, actual: string) => void;

export interface UseRemoteBrowserUrlOptions {
  paneId: string;
  /**
   * The remote host this pane's workspace lives on, or null for this
   * machine. A `localhost:<port>` URL for a port that host reports goes
   * through a port forward (ADR-178 §5).
   */
  remoteHostId: string | null;
  initialUrl: string;
  webviewRef: RefObject<SrcElement | null>;
}

export interface UseRemoteBrowserUrlResult {
  /** The webview's `src` — the forwarded URL actually loaded, never the remembered box URL. */
  src: string;
  /** Waiting on a disconnected/reconnecting host to resolve a remembered URL. */
  waiting: boolean;
  /** The host's display target, for the "Waiting for …" label. */
  hostLabel: string | null;
  /** Whether the initial load is deferred until the host resolves it. */
  deferInitialLoad: boolean;
  /** Kicks off the deferred initial load, once the webview element exists. */
  resolveInitialLoad: () => void;
  /** Loads `resolved` — remote localhost URLs go through a port forward. */
  navigate: (resolved: string) => void;
  /** A `did-navigate`/`did-navigate-in-page` handler wrapping the remote-URL remembering logic. */
  onNavigate: (e: Event, apply: ApplyNavigation) => void;
}

interface WebviewNavigateEvent extends Event {
  url: string;
  isMainFrame: boolean;
}

/**
 * Remote panes (ADR-178 §5) remember and show the box's own URL
 * (`localhost:<remote port>`) but load it through a port forward
 * (`127.0.0.1:<local port>`), which only exists while the host is connected
 * and whose local port may change. So a remote pane's webview `src` follows
 * the URL actually loaded, never the remembered one, and a remembered
 * loopback URL is not loaded until main has resolved it against the
 * connected host — a "waiting for host" state until then, rather than a
 * load of the same port on this machine.
 *
 * Moved out of `BrowserPane.tsx` (ADR-183 ticket 10) — this hook owns every
 * bit of that bookkeeping; `BrowserPane` still owns the generic nav state
 * (URL bar, title, history, …) via the `apply` callback passed to
 * `onNavigate`.
 */
export function useRemoteBrowserUrl(
  options: UseRemoteBrowserUrlOptions,
): UseRemoteBrowserUrlResult {
  const { paneId, remoteHostId, initialUrl, webviewRef } = options;

  const remoteHostIdRef = useRef(remoteHostId);
  remoteHostIdRef.current = remoteHostId;

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
  /** The `about:blank` placeholder a deferred remote tab sits on is not a page. */
  const skipBlankRef = useRef(deferInitialLoad);

  const host = useHostStore(selectHost(remoteHostId));
  const hostStatus = remoteHostId ? (host?.status ?? null) : null;
  const display = useHostDisplay(remoteHostId);
  const hostLabel = display?.target ?? null;

  /**
   * Loads `remoteUrl` — the box's own `localhost:<port>` URL — through its
   * port forward, once main has one; the pane waits for the host until
   * then. The URL bar keeps showing `remoteUrl`.
   */
  const resolveRemote = (remoteUrl: string) => {
    const hostId = remoteHostIdRef.current;
    if (!hostId) return;
    const seq = ++resolveSeqRef.current;
    setWaitingForHost(true);
    resolveUrlForHost(remoteUrl, hostId).then((target) => {
      if (seq !== resolveSeqRef.current) return;
      setWaitingForHost(false);
      const wv = webviewRef.current;
      if (!wv) return;
      wv.src = target;
      setLoadedUrl(target);
    });
  };

  const navigate = (resolved: string) => {
    const hostId = remoteHostIdRef.current;
    if (hostId && isLocalhostHttpUrl(resolved)) {
      resolveRemote(resolved);
      return;
    }
    resolveSeqRef.current++; // a pending remote resolve is superseded
    setWaitingForHost(false);
    const wv = webviewRef.current;
    if (wv) wv.src = resolved;
    if (hostId) setLoadedUrl(resolved);
  };

  const resolveInitialLoad = () => {
    if (deferInitialLoad) resolveRemote(initialUrl);
  };

  const onNavigate = (e: Event, apply: ApplyNavigation) => {
    const nav = e as WebviewNavigateEvent;
    if (nav.isMainFrame === false) return;
    const newUrl = nav.url;
    const seq = ++navSeqRef.current;
    const hostId = remoteHostIdRef.current;
    if (!hostId) {
      apply(newUrl, newUrl);
      return;
    }
    if (newUrl === "about:blank" && skipBlankRef.current) return;
    skipBlankRef.current = false;
    setLoadedUrl(newUrl);
    if (!isLocalhostHttpUrl(newUrl)) {
      apply(newUrl, newUrl);
      return;
    }
    // Remember the box's URL, not the forward's: it outlives the forward.
    window.electronAPI.ports.remoteUrl(newUrl, hostId).then(
      (shown) => {
        if (seq === navSeqRef.current) apply(shown, newUrl);
      },
      () => {
        if (seq === navSeqRef.current) apply(newUrl, newUrl);
      },
    );
  };

  // A remote pane's forward dies with its host's connection, and may come
  // back on another local port: once the host is connected again, the page
  // is re-resolved and moved if its forward moved.
  const prevHostStatusRef = useRef(hostStatus);
  useEffect(() => {
    const prev = prevHostStatusRef.current;
    prevHostStatusRef.current = hostStatus;
    if (hostStatus !== "connected" || prev === "connected" || prev === null) return;
    if (waitingForHostRef.current) return; // main is already waiting on it
    const hostId = remoteHostIdRef.current;
    const remembered = selectPaneUrl(useAppStore.getState(), paneId);
    if (!hostId || !remembered || !isLocalhostHttpUrl(remembered)) return;
    const seq = ++resolveSeqRef.current;
    resolveUrlForHost(remembered, hostId).then((target) => {
      if (seq !== resolveSeqRef.current) return;
      const wv = webviewRef.current;
      if (!wv || sameHost(target, loadedUrlRef.current)) return;
      wv.src = target;
      setLoadedUrl(target);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostStatus, paneId]);

  // Cancel any in-flight resolve/nav lookups on unmount.
  useMountEffect(() => {
    return () => {
      resolveSeqRef.current++;
      navSeqRef.current++;
    };
  });

  return {
    src: remoteHostId ? loadedUrl : initialUrl,
    waiting: waitingForHost,
    hostLabel,
    deferInitialLoad,
    resolveInitialLoad,
    navigate,
    onNavigate,
  };
}
