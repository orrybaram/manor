/**
 * useTerminalLifecycle — orchestrates xterm creation, addon loading,
 * PTY connection, event subscriptions, and cleanup.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { terminalOptions } from "../terminal/config";
import { whenTerminalCanOpen, type RenderAddons } from "../terminal/addons";
import { createFileLinkProvider } from "../terminal/file-link-provider";
import { selectFocusedPaneOfActiveTab, useAppStore } from "../store/app-store";
import { parseWorkspaceKey, workspaceKey as makeWorkspaceKey, type WorkspaceKey } from "../lib/workspace-key";
import { ownerOf } from "../lib/workspace-directory";
import { openExternal } from "../lib/open-external";
import { handleBridgeUnavailable } from "../lib/bridge-unavailable-toast";
import { useProjectStore } from "../store/project-store";
import { getAgentKindForCommand } from "../agent-defaults";
import { isNavRegionKeyboardFocused } from "../lib/focus-regions";
import { classifyShellOutput } from "../lib/shell-ready";
import { installKittyKeyboard } from "../lib/kitty-keyboard";
import { paneCreateHostId, useTerminalConnection } from "./useTerminalConnection";
import { useRemotePaneStore } from "../store/remote-pane-store";
import { isRemotePane, pasteClipboardImage } from "../lib/remote-image-paste";
import type { PtyWinsize } from "../electron.d";
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
  /** Key of the workspace the pane belongs to; its host is where the pane runs. */
  workspaceKey?: WorkspaceKey,
) {
  const [term, setTerm] = useState<Terminal | null>(null);
  const [fitAddon, setFitAddon] = useState<FitAddon | null>(null);
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
  const applyWinsize = useCallback((result: PtyWinsize) => {
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

  // Ownership can move after the create reply too (ADR-179 D6) — another
  // bridge viewer's `pty.create` outbids this one, or a desktop window
  // attaches or lets go — and `applyWinsize` only ever reads the reply of a
  // call *this* viewer made. `pty.onWinsizeOwner` is the live half: on the
  // desktop it is a no-op subscription (the desktop's own attach always wins,
  // so it never needs to be told it lost something), and on the bridge it is
  // what lets a follower become the owner, or the reverse, without a
  // `pty.create` of its own. Flipping `follower` is the whole of the reaction
  // — `useTerminalResize` re-runs on that dependency and sends a fit or
  // re-fits to the new grid on its own.
  useEffect(() => {
    return window.electronAPI.pty.onWinsizeOwner(paneId, (payload) => {
      if (payload.owner) {
        setFollower(null);
        return;
      }
      const { cols, rows } = payload;
      if (!cols || !rows) return;
      setFollower((prev) =>
        prev && prev.cols === cols && prev.rows === rows
          ? prev
          : { cols, rows },
      );
    });
  }, [paneId]);
  const resettingRef = useRef(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { write, resize, create, detach } =
    useTerminalConnection(paneId, workspaceKey);
  const { attachHandler } = useTerminalHotkeys(onOpenSearch);

  // Subscribe to stream events.
  // Output stays queued until openRestored() — see the create() call below.
  const { openRestored, closeOutput } = useTerminalStream(
    paneId,
    term,
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
    // navigation region (sidebar, tab bar, status bar; ADR-175) from the
    // keyboard. Arrowing to a row switches workspaces, which flips this
    // selector, and focusing here would yank focus straight back out of the
    // row. A mouse click on a row or tab hands the keyboard to the pane.
    if (demanded || fresh || !isNavRegionKeyboardFocused()) t.focus();
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

    // The terminal is created once its fonts and render add-ons are in hand
    // (see `terminal/addons`); a pane unmounted before then never makes one.
    const openTerminal = (addons: RenderAddons): (() => void) => {
      // Remounted because its remote host came back (ADR-178 §6), not opened
      // by the user: it must not take focus from wherever the user is now.
      const reattached = useRemotePaneStore.getState().consumeReattach(paneId);

      // The theme as of now, not as of mount: it may have changed while the
      // pane waited, and the render-time sync above had no terminal to apply
      // it to.
      const currentTheme = prevThemeRef.current;
      const t = new Terminal(
        terminalOptions({
          ...(currentTheme ? { theme: currentTheme } : {}),
          linkHandler: {
            activate: (_event, text) => {
              openExternal(text);
            },
          },
        }),
      );

      const fit = new FitAddon();
      t.loadAddon(fit);
      registerTerminal(paneId, t);

      if (addons.Unicode11Addon) {
        t.loadAddon(new addons.Unicode11Addon());
        t.unicode.activeVersion = "11";
      }

      t.open(container);

      // Intercept the DOM paste event on remote panes when the clipboard holds
      // an image and no text (Cmd+V on macOS, Ctrl+Shift+V, the Edit menu —
      // Ctrl+V is handled by attachHandler above and never reaches here on
      // Linux/Windows). Capture phase so this runs before xterm's own paste
      // listener on the same element (ADR-187 §4).
      const onDomPaste = (e: ClipboardEvent) => {
        if (!isRemotePane(paneId)) return;
        const items = e.clipboardData?.items;
        const hasImage = items
          ? Array.from(items).some((item) => item.type.startsWith("image/"))
          : false;
        const hasText = !!e.clipboardData?.getData("text/plain");
        if (!hasImage || hasText) return;
        e.preventDefault();
        e.stopPropagation();
        void pasteClipboardImage(t, paneId, () => {});
      };
      container.addEventListener("paste", onDomPaste, true);

      // Post-open addons (require DOM/canvas)
      if (addons.WebglAddon) {
        try {
          const webgl = new addons.WebglAddon();
          webgl.onContextLoss(() => webgl.dispose());
          t.loadAddon(webgl);
        } catch (e) {
          console.warn("WebGL addon failed, using DOM renderer", e);
        }
      }

      try {
        t.loadAddon(new ClipboardAddon());
      } catch {
        // ignored
      }
      if (addons.ImageAddon) {
        try {
          t.loadAddon(new addons.ImageAddon());
        } catch {
          // ignored
        }
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

      // File path links (Cmd/Ctrl+click to open in editor)
      t.registerLinkProvider(
        createFileLinkProvider(t, paneId, cwd ?? ""),
      );

      // Hotkeys
      attachHandler(t, paneId, write);

      // Kitty keyboard protocol, answered from the parser (disposed with `t`)
      installKittyKeyboard(t, write);

      termRef.current = t;
      setTerm(t);
      setFitAddon(fit);

      // Create or attach to daemon session
      const cols = t.cols;
      const rows = t.rows;
      let disposed = false;

      // Arm the CWD listener BEFORE create() resolves. The shell can emit its
      // first OSC 7 (precmd) event in the gap between promise resolution and
      // subscription setup — if we subscribe in the .then() we race that event
      // and miss it, causing the command to wait for the 3s fallback (or never
      // run at all if the fallback is cleared elsewhere).
      //
      // The OSC 7 alone is not enough: it is emitted from precmd /
      // PROMPT_COMMAND, before the line editor puts the tty in raw mode, and a
      // command longer than the 4095-byte canonical line limit typed then loses
      // its tail and its \r. So the shell counts as ready once output follows
      // the OSC 7 — the prompt, drawn after the switch — or, for a prompt that
      // prints nothing, shortly after the OSC 7 (see `classifyShellOutput`).
      let shellReady = false;
      let osc7Seen = false;
      let shellReadyFallback: ReturnType<typeof setTimeout> | undefined;
      let shellReadyPending: (() => void) | null = null;
      const markShellReady = () => {
        if (shellReady) return;
        shellReady = true;
        clearTimeout(shellReadyFallback);
        const fn = shellReadyPending;
        shellReadyPending = null;
        fn?.();
      };
      const armShellReadyFallback = () => {
        osc7Seen = true;
        if (shellReady || shellReadyFallback) return;
        shellReadyFallback = setTimeout(markShellReady, 250);
      };
      const cwdLatchUnsub = window.electronAPI.pty.onCwd(paneId, armShellReadyFallback);
      const promptLatchUnsub = window.electronAPI.pty.onOutput(paneId, (data) => {
        if (shellReady) return;
        const kind = classifyShellOutput(data);
        if (kind === "ready" || (kind === "output" && osc7Seen)) markShellReady();
        else if (kind === "osc7") armShellReadyFallback();
      });
      const onShellReady = (fn: () => void) => {
        if (shellReady) fn();
        else shellReadyPending = fn;
      };

      // Submit with a carriage return (\r) — that's what an Enter keypress
      // sends in xterm.js. Under zsh's raw-mode line editor, \n (Ctrl+J) is
      // not reliably bound to accept-line, so the command would sit in the
      // buffer un-submitted. Without `submit` the text is only typed, for the
      // user to review (ADR-178 ticket 5's "fix in terminal").
      const withEnter = (text: string, submit: boolean) =>
        submit ? text + "\r" : text;

      // Send `text` once: either when the shell prompt is ready (CWD event) or
      // after a 3s fallback, whichever comes first. A write the pane's away
      // remote host drops (see `useTerminalConnection`) does not count: the
      // text stays unsent instead. One path for commands and typed text alike
      // (ADR-183).
      const sendOnShellReady = (
        text: string,
        { submit, onSent }: { submit: boolean; onSent?: () => void },
      ) => {
        // Declared before `send` can run: onShellReady calls it synchronously
        // when the CWD event already arrived.
        let fallback: ReturnType<typeof setTimeout> | undefined;
        let sent = false;
        const send = () => {
          if (sent || disposed) return;
          sent = write(withEnter(text, submit));
          if (!sent) return;
          clearTimeout(fallback);
          onSent?.();
        };
        onShellReady(send);
        if (!sent) fallback = setTimeout(send, 3000);
      };

      // Derive agentKind from the project's agent command so MANOR_AGENT_KIND
      // is set in the PTY env for connector-aware spawns.
      // The pane's project: its cwd on the pane's host (local when it has no key).
      const cwdProject = cwd
        ? ownerOf(
            useProjectStore.getState().projects,
            makeWorkspaceKey(
              workspaceKey ? parseWorkspaceKey(workspaceKey).hostId : null,
              cwd,
            ),
          )
        : undefined;
      const agentKindForCreate: string | null = (() => {
        if (!cwd) return null;
        const project = cwdProject;
        const command = project?.agentCommand ?? null;
        return command ? getAgentKindForCommand(command) : "claude";
      })();

      // The home sentinel path resolves to ~/.manor/home at the pty boundary
      // (see resolveSpawnCwd in electron/ipc/pty.ts), so it needs no special
      // casing here — pass it through like any workspace path.
      const spawnCwd = cwd ?? null;

      create(spawnCwd, cols, rows, agentKindForCreate).then(
        (result) => {
          if (disposed) return;
          applyWinsize(result);
          if (!result.ok) {
            // "host-unavailable" is not a failure: the pane's remote host is
            // away, its banner says so, and the pane is created once the host
            // is back (useRemoteRecovery) — not the "terminal failed to start"
            // dialog.
            if (result.reason === "error") {
              setPtyError(result.error || "Failed to create terminal session");
            }
            return;
          }
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
            const project = cwdProject;

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

          // A pane opened "with a command" — a new agent, a split with an
          // agent, `POST /tabs { command }`, a fix-it command to review — has
          // its line waiting on the server, and `pty.create` typed it on the
          // way in (ADR-179 ticket 11). Nothing to read back here: the queue
          // is not this renderer's any more, which is what lets a route open
          // such a pane at all.
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
              sendOnShellReady(resumeCmd ?? resumeAgent.agentCommand!, { submit: true });
            })();
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

      // A reattached pane only takes focus back if it had it: its old xterm,
      // focused, was just unmounted from under the user's cursor.
      if (!reattached || (isFocusedPane && !isNavRegionKeyboardFocused())) t.focus();

      return () => {
        disposed = true;
        container.removeEventListener("paste", onDomPaste, true);
        // Queue output again for whoever attaches next: the ordering guarantee
        // belongs to each attach, not to the first one of this component's life.
        closeOutput();
        cwdLatchUnsub();
        promptLatchUnsub();
        clearTimeout(shellReadyFallback);
        if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
        titleDisposable.dispose();
        dataDisposable.dispose();
        setTerm(null);
        setFitAddon(null);
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
    };

    let unmounted = false;
    let teardown: (() => void) | undefined;
    whenTerminalCanOpen().then(
      (addons) => {
        if (!unmounted) teardown = openTerminal(addons);
      },
      (err: unknown) => {
        if (!unmounted) {
          setPtyError(
            err instanceof Error ? err.message : "Failed to load the terminal",
          );
        }
      },
    );

    return () => {
      unmounted = true;
      teardown?.();
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
      // A fresh session on the host the pane runs on, as create picks it: a
      // pane moved to another host (ADR-183) stays there.
      const result = await window.electronAPI.pty.reset(
        paneId,
        cwd ?? null,
        t.cols,
        t.rows,
        { hostId: paneCreateHostId(paneId, workspaceKey) },
      );
      // Reset is create-shaped on the bridge too, and a pane the desktop holds
      // is still the desktop's after one (ADR-178 D5).
      applyWinsize(result);
      if (!result.ok) {
        setPtyError(result.error ?? "Failed to create terminal session");
      } else {
        // Record where the fresh session really runs.
        useRemotePaneStore.getState().setPaneHost(paneId, result.hostId);
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
  }, [paneId, cwd, workspaceKey, applyWinsize]);

  return { term, fitAddon, ptyError, write, reset, follower };
}
