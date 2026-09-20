/**
 * useTerminalLifecycle — orchestrates xterm creation, addon loading,
 * PTY connection, event subscriptions, and cleanup.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { terminalOptions } from "../terminal/config";
import { createFileLinkProvider } from "../terminal/file-link-provider";
import { openExternal } from "../lib/open-external";
import { handleBridgeUnavailable } from "../lib/bridge-unavailable-toast";
import {
  useAppStore,
  selectFocusedPaneOfActiveTab,
} from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import { usePreferencesStore } from "../store/preferences-store";
import { getAgentKindForCommand } from "../agent-defaults";
import { isHomePath } from "../lib/home";
import { isNavRegionFocused } from "../lib/focus-regions";
import type { PtyCreateResult } from "../electron.d";
import { resolveHomeAdapter } from "../lib/harness";
import { useTerminalConnection } from "./useTerminalConnection";
import { useTerminalStream } from "./useTerminalStream";
import { useTerminalHotkeys } from "./useTerminalHotkeys";
import { useTerminalResize } from "./useTerminalResize";
import { useMountEffect } from "./useMountEffect";
import {
  registerTerminal,
  unregisterTerminal,
} from "../lib/terminal-registry";
import type { ITheme } from "@xterm/xterm";

export function useTerminalLifecycle(
  containerRef: React.RefObject<HTMLDivElement | null>,
  paneId: string,
  cwd: string | undefined,
  theme: ITheme | null,
  onOpenSearch?: () => void,
) {
  const [term, setTerm] = useState<Terminal | null>(null);
  const [fitAddon, setFitAddon] = useState<FitAddon | null>(null);
  const [searchAddon, setSearchAddon] = useState<SearchAddon | null>(null);
  const [ptyError, setPtyError] = useState<string | null>(null);
  /**
   * The winsize owner's grid, when this viewer is not the owner (ADR-178 D5).
   *
   * Null until the create reply says otherwise, and null forever in the desktop
   * app: `winsizeOwner` is the bridge's field and the preload path never sets
   * it, so absent means owner. Held as one object so the identity a follower
   * hands `useTerminalResize` is stable between renders.
   */
  const [follower, setFollower] = useState<{ cols: number; rows: number } | null>(
    null,
  );
  const termRef = useRef<Terminal | null>(null);
  /**
   * Read the winsize ownership off a create-shaped reply.
   *
   * Every field here is optional and absent on the desktop, so the one shape
   * this has to get right is "said nothing" — which means this viewer owns the
   * winsize and the hook behaves exactly as it did before ADR-178.
   */
  const applyWinsize = useCallback((result: PtyCreateResult) => {
    const { winsizeOwner, cols, rows } = result;
    if (winsizeOwner === false && cols && rows) {
      // Same object back when the grid has not moved: this is the identity
      // `useTerminalResize` re-runs its effect on.
      setFollower((prev) =>
        prev && prev.cols === cols && prev.rows === rows
          ? prev
          : { cols, rows },
      );
    } else {
      setFollower(null);
    }
  }, []);
  const resettingRef = useRef(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { write, resize, create, detach } =
    useTerminalConnection(paneId);
  const { attachHandler } = useTerminalHotkeys(onOpenSearch);

  // Subscribe to stream events (pass write so the stream handler can
  // respond to kitty keyboard protocol queries on behalf of xterm.js).
  // Output stays queued until openRestored() — see the create() call below.
  const { openRestored, closeOutput } = useTerminalStream(
    paneId,
    term,
    write,
    setPtyError,
    resettingRef,
  );

  // Auto-resize — or, for a follower, auto-*fit*: see ADR-178 D5.
  useTerminalResize(containerRef, fitAddon, term, resize, follower);

  // Auto-focus terminal when this pane becomes the focused pane of the active tab.
  // Uses a selector + useEffect so focus() runs after React commits DOM changes
  // (the container's visibility must be "visible" before focus can succeed).
  const isFocusedPane = useAppStore(
    (state) => selectFocusedPaneOfActiveTab(state) === paneId,
  );

  // An explicit refocusActivePane() — Escape out of the sidebar, say — bumps
  // this nonce; the bump is the only thing that overrides the sidebar guard
  // below (ADR-172).
  const paneFocusNonce = useAppStore((state) => state.paneFocusNonce);
  const seenFocusNonce = useRef(paneFocusNonce);
  const firstFocusRun = useRef(true);

  useEffect(() => {
    // Record what this pane has seen before bailing out, so an unfocused pane
    // never banks a bump meant for its neighbour and spends it later, when it
    // becomes the focused pane for an unrelated reason.
    const demanded = seenFocusNonce.current !== paneFocusNonce;
    seenFocusNonce.current = paneFocusNonce;
    // Likewise, a mount is a mount whether or not this pane is the focused
    // one: a freshly opened pane may claim focus, a long-lived one may not.
    const fresh = firstFocusRun.current;
    firstFocusRun.current = false;

    if (!isFocusedPane || !termRef.current) return;
    const t = termRef.current;
    // Focus the terminal for keyboard input — unless the user is driving a
    // navigation region (sidebar, tab bar, status bar; ADR-175). Clicking a
    // row switches workspaces, which flips this selector, and focusing here
    // would yank focus straight back out of the row.
    if (demanded || fresh || !isNavRegionFocused()) t.focus();
    // Force a full viewport refresh — TUIs (neovim, claude code) using the
    // WebGL renderer can have a stale canvas after being visibility:hidden.
    // The pane became visible either way, so this runs even when focus stayed
    // in the sidebar.
    t.refresh(0, t.rows - 1);
  }, [isFocusedPane, paneFocusNonce]);

  // Update theme without recreating the terminal or the PTY session.
  // Ref-based render-time check: when theme changes, apply it immediately.
  const prevThemeRef = useRef<ITheme | null>(theme);
  if (theme !== prevThemeRef.current) {
    prevThemeRef.current = theme;
    if (termRef.current && theme) {
      termRef.current.options.theme = theme;
    }
  }

  // Main lifecycle — paneId and cwd are stable for a given mount (component
  // is keyed by paneId). Converted from useEffect to useMountEffect.
  useMountEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const t = new Terminal(
      terminalOptions({
        ...(theme ? { theme } : {}),
        linkHandler: {
          activate: (_event, text) => {
            openExternal(text);
          },
        },
      }),
    );

    const fit = new FitAddon();
    t.loadAddon(fit);
    const search = new SearchAddon();
    t.loadAddon(search);
    const serialize = new SerializeAddon();
    t.loadAddon(serialize);
    registerTerminal(paneId, { term: t, serialize });

    const unicode11 = new Unicode11Addon();
    t.loadAddon(unicode11);
    t.unicode.activeVersion = "11";

    t.open(container);

    // Post-open addons (require DOM/canvas)
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      t.loadAddon(webgl);
    } catch (e) {
      console.warn("WebGL addon failed, using DOM renderer", e);
    }

    try {
      t.loadAddon(new ClipboardAddon());
    } catch {
      // ignored
    }
    try {
      t.loadAddon(new ImageAddon());
    } catch {
      // ignored
    }
    try {
      t.loadAddon(
        new WebLinksAddon((_event, url) => {
          openExternal(url);
        }),
      );
    } catch {
      // ignored
    }

    // Fit only once every addon is loaded. The WebGL addon swaps the render
    // service and with it the measured cell size, so fitting before that can
    // report different cols/rows than the settled layout — and the correction
    // reaches the PTY as a SIGWINCH that makes full-screen TUIs repaint their
    // frame into the scrollback.
    fit.fit();

    // File path links (CMD+click to open in editor)
    t.registerLinkProvider(
      createFileLinkProvider(t, paneId, cwd ?? ""),
    );

    // Hotkeys
    attachHandler(t, write);

    termRef.current = t;
    setTerm(t);
    setFitAddon(fit);
    setSearchAddon(search);

    // Create or attach to daemon session
    const cols = t.cols;
    const rows = t.rows;
    let disposed = false;

    // Arm the CWD listener BEFORE create() resolves. The shell can emit its
    // first OSC 7 (precmd) event in the gap between promise resolution and
    // subscription setup — if we subscribe in the .then() we race that event
    // and miss it, causing the command to wait for the 3s fallback (or never
    // run at all if the fallback is cleared elsewhere).
    let cwdSeen = false;
    let cwdPending: (() => void) | null = null;
    const cwdLatchUnsub = window.electronAPI.pty.onCwd(paneId, () => {
      cwdSeen = true;
      const fn = cwdPending;
      cwdPending = null;
      fn?.();
    });
    const onShellReady = (fn: () => void) => {
      if (cwdSeen) fn();
      else cwdPending = fn;
    };

    // Send `cmd` once: either when the shell prompt is ready (CWD event) or
    // after a 3s fallback, whichever comes first.
    const sendOnShellReady = (cmd: string) => {
      let sent = false;
      const send = () => {
        if (sent || disposed) return;
        sent = true;
        clearTimeout(fallback);
        // Submit with a carriage return (\r) — that's what an Enter keypress
        // sends in xterm.js. Under zsh's raw-mode line editor, \n (Ctrl+J) is
        // not reliably bound to accept-line, so the command would sit in the
        // buffer un-submitted.
        write(cmd + "\r");
      };
      onShellReady(send);
      const fallback = setTimeout(send, 3000);
    };

    // Derive agentKind from the project's agent command so MANOR_AGENT_KIND
    // is set in the PTY env for connector-aware spawns.
    const agentKindForCreate: string | null = (() => {
      if (!cwd) return null;
      if (isHomePath(cwd)) {
        const prefs = usePreferencesStore.getState().preferences;
        return getAgentKindForCommand(
          resolveHomeAdapter(prefs).launchCommand(),
        );
      }
      const projects = useProjectStore.getState().projects;
      const project = projects.find((p) =>
        p.workspaces.some((ws) => ws.path === cwd),
      );
      const command = project?.agentCommand ?? null;
      return command ? getAgentKindForCommand(command) : "claude";
    })();

    // The home sentinel path resolves to ~/.manor/home at the pty boundary
    // (see resolveSpawnCwd in electron/ipc/pty.ts), so it needs no special
    // casing here — pass it through like any workspace path.
    const spawnCwd = cwd ?? null;

    create(spawnCwd, cols, rows, agentKindForCreate).then(
      (result: PtyCreateResult) => {
        if (disposed) return;
        applyWinsize(result);
        if (!result.ok) {
          setPtyError(
            result.error ?? "Failed to create terminal session",
          );
          return;
        }
        if (result.ok) {
          // Sync the terminal with the daemon and let output flow. Writing the
          // snapshot and releasing the queue is one operation — split apart,
          // the snapshot repeats bytes already on screen.
          openRestored(
            t,
            result.snapshot
              ? { ansi: result.snapshot, seq: result.snapshotSeq }
              : null,
          );

          // Set pane context for agent association
          if (cwd) {
            if (isHomePath(cwd)) {
              // The home has no owning project — associate the pane with
              // the sentinel workspace and the resolved harness command.
              const prefs = usePreferencesStore.getState().preferences;
              window.electronAPI.agents
                .setPaneContext(paneId, {
                  projectId: "",
                  projectName: "Home",
                  workspacePath: cwd,
                  agentCommand: resolveHomeAdapter(prefs).launchCommand(),
                })
                .catch(
                  handleBridgeUnavailable(
                    "agents-set-pane-context-unavailable",
                    "Pane context isn't synced from the browser yet",
                  ),
                );
            } else {
              const projects = useProjectStore.getState().projects;
              const project = projects.find((p) =>
                p.workspaces.some((ws) => ws.path === cwd),
              );

              // Fire-and-forget call to set pane context
              window.electronAPI.agents
                .setPaneContext(paneId, {
                  projectId: project?.id ?? "",
                  projectName: project?.name ?? "",
                  workspacePath: cwd,
                  agentCommand: project?.agentCommand ?? null,
                })
                .catch(
                  handleBridgeUnavailable(
                    "agents-set-pane-context-unavailable",
                    "Pane context isn't synced from the browser yet",
                  ),
                );
            }
          }

          // A pane opened "with a command" — a new agent, a split with an
          // agent, `POST /tabs { command }` — has its line waiting on the
          // server, and `pty.create` typed it on the way in (ADR-179 ticket
          // 11). Nothing to read back here: the queue is not this renderer's
          // any more, which is what lets a route open such a pane at all.
          if (!result.snapshot) {
            // No warm-restore snapshot → cold or fresh session. Check for an
            // active agent that was interrupted (e.g. version upgrade, app
            // crash) and auto-relaunch its agent command.
            void (async () => {
              const activeAgents = await window.electronAPI.agents.getAll({ status: "active" });
              const resumeAgent = activeAgents.find(
                (t) => t.paneId === paneId && !t.resumedAt && t.agentCommand,
              );
              if (!resumeAgent || disposed) return;

              // Mark resumed immediately to prevent double-launch on re-mount
              void window.electronAPI.agents.markResumed(resumeAgent.id);

              // Resume the prior agent session if we can; otherwise relaunch the bare command.
              const resumeCmd = await window.electronAPI.agents.buildResumeCommand(resumeAgent.id);
              if (disposed) return;
              sendOnShellReady(resumeCmd ?? resumeAgent.agentCommand!);
            })();
          }
        }
      },
      (err: unknown) => {
        if (!disposed) {
          setPtyError(
            err instanceof Error ? err.message : "Failed to create terminal session",
          );
        }
      },
    );

    // Terminal title changes (OSC sequences) → local side map only. The
    // server hears the same title from the daemon and records it itself.
    const titleDisposable = t.onTitleChange((title) => {
      useAppStore.getState().setPaneTitleFromStream(paneId, title);
    });

    // User input → PTY
    const dataDisposable = t.onData(write);

    t.focus();

    return () => {
      disposed = true;
      // Queue output again for whoever attaches next: the ordering guarantee
      // belongs to each attach, not to the first one of this component's life.
      closeOutput();
      cwdLatchUnsub();
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      titleDisposable.dispose();
      dataDisposable.dispose();
      setTerm(null);
      setFitAddon(null);
      setSearchAddon(null);
      termRef.current = null;
      unregisterTerminal(paneId);
      // Detach, always: the session stays alive in the daemon and this pane
      // may be about to mount again somewhere else. Ending a session is the
      // Manor server's job — it kills the panes a `close-pane` orphaned
      // (ADR-179 D2 `effects.killPanes`) — so a pane that unmounts *because*
      // it was closed has already lost its session by the time we get here,
      // and detaching from a session that is gone is quiet by design.
      detach();
      t.dispose();
    };
  });

  /** Kill the current PTY, reset xterm, and spawn a fresh shell session. */
  const reset = useCallback(async () => {
    const t = termRef.current;
    if (!t) return;
    // Suppress the exit handler so the pane isn't closed during reset.
    resettingRef.current = true;
    try {
      t.reset();
      const result = await window.electronAPI.pty.reset(
        paneId,
        cwd ?? null,
        t.cols,
        t.rows,
      );
      // Reset is create-shaped on the bridge too, and a pane the desktop holds
      // is still the desktop's after one (ADR-178 D5).
      applyWinsize(result);
      if (!result.ok) {
        setPtyError(result.error ?? "Failed to create terminal session");
      }
    } finally {
      // Keep suppressing exit events briefly — the old session's exit
      // event may still be in the IPC pipeline after the reset resolves.
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => {
        resetTimerRef.current = null;
        resettingRef.current = false;
      }, 1_000);
    }
  }, [paneId, cwd, applyWinsize]);

  return { term, fitAddon, searchAddon, ptyError, write, reset, follower };
}
