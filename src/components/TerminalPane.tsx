import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { init, Terminal } from "ghostty-web";
import { useThemeStore } from "../store/theme-store";
import { useAppStore } from "../store/app-store";

const ghosttyReady = init();

interface TerminalPaneProps {
  paneId: string;
  cwd?: string;
}

export function TerminalPane({ paneId, cwd }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const theme = useThemeStore((s) => s.theme);

  useEffect(() => {
    let disposed = false;
    let term: Terminal | null = null;
    let cleanupListener: (() => void) | null = null;
    let cleanupExitListener: (() => void) | null = null;
    let cleanupCwdListener: (() => void) | null = null;

    async function setup() {
      await ghosttyReady;
      if (disposed) return;

      term = new Terminal({
        fontSize: 14,
        fontFamily: "Menlo, Monaco, 'Courier New', monospace",
        cursorBlink: true,
        ...(theme ? { theme } : {}),
      });

      term.open(containerRef.current!);

      // Intercept app-level shortcuts before the terminal swallows them.
      // Must be called AFTER open() so the input handler exists.
      // ghostty-web's handler: return true → preventDefault + stop terminal processing
      // Since it calls preventDefault, we must dispatch to window ourselves.
      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (!e.metaKey) return false; // let terminal handle all non-Cmd keys

        const isAppShortcut = (() => {
          switch (e.key) {
            case "t":
            case "k":
            case "d":
            case "D":
            case "w":
            case "W":
            case "\\":
              return true;
            case "]":
            case "[":
              return e.shiftKey;
            default:
              return false;
          }
        })();

        if (isAppShortcut) {
          // Re-dispatch on window so our keydown handler picks it up
          window.dispatchEvent(new KeyboardEvent("keydown", {
            key: e.key,
            code: e.code,
            metaKey: e.metaKey,
            ctrlKey: e.ctrlKey,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            bubbles: true,
          }));
          return true; // tell ghostty-web to stop processing this key
        }

        return false; // let terminal handle other Cmd combos
      });

      const cols = term.cols;
      const rows = term.rows;

      // Create PTY session in Rust backend
      await invoke("pty_create", { paneId, cwd, cols, rows });

      // PTY output → terminal display
      const unlistenOutput = await listen<{ data: string }>(
        `pty-output-${paneId}`,
        (event) => {
          term?.write(event.payload.data);
        }
      );
      cleanupListener = unlistenOutput;

      // PTY exit notification
      const unlistenExit = await listen(`pty-exit-${paneId}`, () => {
        term?.write("\r\n[Process exited]\r\n");
      });
      cleanupExitListener = unlistenExit;

      // CWD tracking via OSC 7
      const unlistenCwd = await listen<string>(`pty-cwd-${paneId}`, (event) => {
        useAppStore.getState().setPaneCwd(paneId, event.payload);
      });
      cleanupCwdListener = unlistenCwd;

      // User input → PTY
      term.onData((data: string) => {
        invoke("pty_write", { paneId, data });
      });

      // Resize → PTY
      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        invoke("pty_resize", { paneId, cols, rows });
      });
    }

    setup();

    return () => {
      disposed = true;
      cleanupListener?.();
      cleanupExitListener?.();
      cleanupCwdListener?.();
      if (term) {
        invoke("pty_close", { paneId });
        term.dispose();
      }
    };
  }, [paneId, cwd, theme]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        overflow: "hidden",
      }}
    />
  );
}
