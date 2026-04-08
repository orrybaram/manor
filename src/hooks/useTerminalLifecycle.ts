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
import { useAppStore } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import { useTerminalConnection } from "./useTerminalConnection";
import { useTerminalStream } from "./useTerminalStream";
import { useTerminalHotkeys } from "./useTerminalHotkeys";
import { useTerminalResize } from "./useTerminalResize";
import { useMountEffect } from "./useMountEffect";
import type { ITheme } from "@xterm/xterm";

/** Grace period (ms) before a closed pane's PTY session is killed. */
const CLOSE_GRACE_MS = 10_000;

/** Pending kill timers for panes that were explicitly closed. */
const pendingKillTimers = new Map<string, ReturnType<typeof setTimeout>>();

function schedulePtyKill(paneId: string) {
  cancelPtyKill(paneId);
  const timer = setTimeout(() => {
    pendingKillTimers.delete(paneId);
    window.electronAPI.pty.close(paneId);
  }, CLOSE_GRACE_MS);
  pendingKillTimers.set(paneId, timer);
}

function cancelPtyKill(paneId: string) {
  const timer = pendingKillTimers.get(paneId);
  if (timer != null) {
    clearTimeout(timer);
    pendingKillTimers.delete(paneId);
  }
}

export function useTerminalLifecycle(
  containerRef: React.RefObject<HTMLDivElement | null>,
  paneId: string,
  cwd: string | undefined,
  theme: ITheme | null,
) {
  const [term, setTerm] = useState<Terminal | null>(null);
  const [fitAddon, setFitAddon] = useState<FitAddon | null>(null);
  const [ptyError, setPtyError] = useState<string | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const resettingRef = useRef(false);
  const { write, resize, create, detach } =
    useTerminalConnection(paneId);
  const { attachHandler } = useTerminalHotkeys();

  // Subscribe to stream events (pass write so the stream handler can
  // respond to kitty keyboard protocol queries on behalf of xterm.js)
  useTerminalStream(paneId, term, write, setPtyError, resettingRef);

  // Auto-resize
  useTerminalResize(containerRef, fitAddon, term);

  // Auto-focus terminal when this pane becomes the focused pane of the active tab.
  // Uses a selector + useEffect so focus() runs after React commits DOM changes
  // (the container's visibility must be "visible" before focus can succeed).
  const isFocusedPane = useAppStore((state) => {
    const path = state.activeWorkspacePath;
    const layout = path ? state.workspaceLayouts[path] : undefined;
    const panel = layout ? layout.panels[layout.activePanelId] : undefined;
    const tab = panel?.tabs.find((t) => t.id === panel?.selectedTabId);
    return tab?.focusedPaneId === paneId;
  });

  useEffect(() => {
    if (!isFocusedPane || !termRef.current) return;
    const t = termRef.current;
    // Focus the terminal for keyboard input
    t.focus();
    // Force a full viewport refresh — TUIs (neovim, claude code) using the
    // WebGL renderer can have a stale canvas after being visibility:hidden.
    t.refresh(0, t.rows - 1);
  }, [isFocusedPane]);

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

    // If this pane was recently closed and is being restored, cancel the
    // pending kill so the daemon session stays alive for reattach.
    cancelPtyKill(paneId);

    const t = new Terminal(
      terminalOptions({
        ...(theme ? { theme } : {}),
        linkHandler: {
          activate: (_event, text) => {
            window.electronAPI.shell.openExternal(text);
          },
        },
      }),
    );

    const fit = new FitAddon();
    t.loadAddon(fit);
    t.loadAddon(new SearchAddon());
    t.loadAddon(new SerializeAddon());

    const unicode11 = new Unicode11Addon();
    t.loadAddon(unicode11);
    t.unicode.activeVersion = "11";

    t.open(container);
    fit.fit();

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
          window.electronAPI.shell.openExternal(url);
        }),
      );
    } catch {
      // ignored
    }

    // File path links (CMD+click to open in editor)
    t.registerLinkProvider(
      createFileLinkProvider(t, paneId, cwd ?? ""),
    );

    // Hotkeys
    attachHandler(t, write);

    termRef.current = t;
    setTerm(t);
    setFitAddon(fit);

    // Create or attach to daemon session
    const cols = t.cols;
    const rows = t.rows;
    let disposed = false;
    create(cwd ?? null, cols, rows).then(
      (result: { ok: boolean; snapshot?: string | null; error?: string; prewarmed?: boolean }) => {
        if (!disposed && !result.ok) {
          setPtyError(
            result.error ?? "Failed to create terminal session",
          );
          return;
        }
        if (!disposed && result.ok) {
          if (result.snapshot) {
            t.write(result.snapshot);
          }

          // Set pane context for task association
          if (cwd) {
            const projects = useProjectStore.getState().projects;
            const project = projects.find((p) =>
              p.workspaces.some((ws) => ws.path === cwd),
            );

            // Fire-and-forget call to set pane context
            window.electronAPI.tasks.setPaneContext(paneId, {
              projectId: project?.id ?? "",
              projectName: project?.name ?? "",
              workspacePath: cwd,
              agentCommand: project?.agentCommand ?? null,
            });
          }

          // Check for pending startup command (e.g. worktree start script)
          const store = useAppStore.getState();
          const wsPath = store.activeWorkspacePath;

          // Pane-specific command (e.g. split-with-task) takes priority
          const paneCmd = store.consumePendingPaneCommand(paneId);
          const startupCmd =
            !paneCmd && wsPath && cwd === wsPath
              ? store.consumePendingStartupCommand(wsPath)
              : null;
          const pendingCmd = paneCmd || startupCmd;
          if (pendingCmd) {
            if (result.prewarmed) {
              // Shell is already initialized — write command immediately
              write(pendingCmd + "\n");
            } else {
              // Cold start — wait for the shell prompt (CWD/OSC 7 event from
              // the precmd hook) before sending the command. Sending on first
              // output is too early: the shell may still be sourcing .zshrc,
              // and ZLE discards buffered input when it initializes.
              let sent = false;
              const send = () => {
                if (sent || disposed) return;
                sent = true;
                clearTimeout(fallback);
                unsubCwd();
                write(pendingCmd + "\n");
              };
              const unsubCwd = window.electronAPI.pty.onCwd(paneId, send);
              const fallback = setTimeout(send, 3000);
            }
          }
        }
      },
    );

    // Terminal title changes (OSC sequences) → store
    const titleDisposable = t.onTitleChange((title) => {
      useAppStore.getState().setPaneTitle(paneId, title);
    });

    // User input → PTY
    const dataDisposable = t.onData(write);

    // Resize → PTY (debounced to avoid flooding the shell with SIGWINCH
    // during continuous window resizes, which causes prompt redraw spam)
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeDisposable = t.onResize(({ cols: c, rows: r }) => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => resize(c, r), 150);
    });

    t.focus();

    return () => {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      titleDisposable.dispose();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      setTerm(null);
      setFitAddon(null);
      termRef.current = null;
      // Always detach (keep the PTY alive in the daemon).
      // If the user explicitly closed the pane, schedule a delayed kill
      // so they can undo within the grace period.
      const { closedPaneIds } = useAppStore.getState();
      detach();
      if (closedPaneIds.has(paneId)) {
        closedPaneIds.delete(paneId);
        schedulePtyKill(paneId);
      }
      t.dispose();
    };
  });

  /** Kill the current PTY, reset xterm, and spawn a fresh shell session. */
  const reset = useCallback(async () => {
    const t = termRef.current;
    if (!t) return;
    // Suppress the exit handler so the pane isn't closed during reset
    resettingRef.current = true;
    try {
      await window.electronAPI.pty.close(paneId);
      t.reset();
      const result = await create(cwd ?? null, t.cols, t.rows);
      if (!result.ok) {
        setPtyError(result.error ?? "Failed to create terminal session");
      }
    } finally {
      resettingRef.current = false;
    }
  }, [paneId, cwd, create]);

  return { term, fitAddon, ptyError, write, reset };
}
