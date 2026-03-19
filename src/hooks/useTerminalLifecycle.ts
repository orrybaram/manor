/**
 * useTerminalLifecycle — orchestrates xterm creation, addon loading,
 * PTY connection, event subscriptions, and cleanup.
 */

import { useEffect, useRef, useState } from "react";
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
import { useAppStore } from "../store/app-store";
import { useTerminalConnection } from "./useTerminalConnection";
import { useTerminalStream } from "./useTerminalStream";
import { useTerminalHotkeys } from "./useTerminalHotkeys";
import { useTerminalResize } from "./useTerminalResize";
import type { ITheme } from "@xterm/xterm";

export function useTerminalLifecycle(
  containerRef: React.RefObject<HTMLDivElement | null>,
  paneId: string,
  cwd: string | undefined,
  theme: ITheme | null,
) {
  const [term, setTerm] = useState<Terminal | null>(null);
  const [fitAddon, setFitAddon] = useState<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fontSize = useAppStore((s) => s.fontSize);
  const { write, resize, create, close, detach } = useTerminalConnection(paneId);
  const { attachHandler } = useTerminalHotkeys();

  // Subscribe to stream events
  useTerminalStream(paneId, term);

  // Auto-resize
  useTerminalResize(containerRef, fitAddon);

  // Auto-focus terminal when this pane becomes the focused pane of the active session
  const isFocusedPane = useAppStore((s) => {
    const path = s.activeWorkspacePath;
    if (!path) return false;
    const ws = s.workspaceSessions[path];
    if (!ws) return false;
    const session = ws.sessions.find((t) => t.id === ws.selectedSessionId);
    return session?.focusedPaneId === paneId;
  });

  useEffect(() => {
    if (isFocusedPane && termRef.current) {
      termRef.current.focus();
    }
  }, [isFocusedPane]);

  // Update font size without recreating
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize;
    }
  }, [fontSize]);

  // Update theme without recreating the terminal or the PTY session
  useEffect(() => {
    if (termRef.current && theme) {
      termRef.current.options.theme = theme;
    }
  }, [theme]);

  // Main lifecycle — only depends on paneId and cwd.
  // Theme changes are handled above without tearing down the session.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const currentTheme = useAppStore.getState();

    const t = new Terminal(terminalOptions({
      fontSize: currentTheme.fontSize,
      ...(theme ? { theme } : {}),
    }));

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

    try { t.loadAddon(new ClipboardAddon()); } catch {}
    try { t.loadAddon(new ImageAddon()); } catch {}
    try {
      t.loadAddon(new WebLinksAddon((_event, url) => {
        window.electronAPI.openExternal(url);
      }));
    } catch {}

    // Hotkeys
    attachHandler(t);

    termRef.current = t;
    setTerm(t);
    setFitAddon(fit);

    // Create or attach to daemon session
    const cols = t.cols;
    const rows = t.rows;
    let disposed = false;
    create(cwd ?? null, cols, rows).then((result: { ok: boolean; snapshot?: string | null }) => {
      if (!disposed && result.ok) {
        if (result.snapshot) {
          t.write(result.snapshot);
        }
        // Check for pending startup command (e.g. worktree start script)
        const store = useAppStore.getState();
        const wsPath = store.activeWorkspacePath;
        if (wsPath && cwd === wsPath) {
          const cmd = store.consumePendingStartupCommand(wsPath);
          if (cmd) {
            // Small delay to let the shell initialize before writing the command
            setTimeout(() => {
              if (!disposed) write(cmd + "\n");
            }, 500);
          }
        }
      }
    });

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
      // Check if this pane was explicitly closed by the user (Cmd+W).
      // If so, kill the daemon session. Otherwise, just detach (keeps it alive for warm restore).
      const { closedPaneIds } = useAppStore.getState();
      if (closedPaneIds.has(paneId)) {
        closedPaneIds.delete(paneId);
        close();
      } else {
        detach();
      }
      t.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, cwd]);

  return { term, fitAddon };
}
