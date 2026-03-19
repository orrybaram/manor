import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { useThemeStore } from "../store/theme-store";
import { useAppStore } from "../store/app-store";

interface TerminalPaneProps {
  paneId: string;
  cwd?: string;
}

export function TerminalPane({ paneId, cwd }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const theme = useThemeStore((s) => s.theme);
  const fontSize = useAppStore((s) => s.fontSize);
  const termRef = useRef<Terminal | null>(null);

  // Update font size without recreating the terminal
  useEffect(() => {
    const term = termRef.current;
    if (term) {
      term.options.fontSize = fontSize;
    }
  }, [fontSize]);

  useEffect(() => {
    let disposed = false;
    let term: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let cleanupListener: (() => void) | null = null;
    let cleanupExitListener: (() => void) | null = null;
    let cleanupCwdListener: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;

    async function setup() {
      if (disposed) return;

      term = new Terminal({
        fontSize: useAppStore.getState().fontSize,
        fontFamily: "'MesloLGM Nerd Font Mono', 'FiraCode Nerd Font', monospace",
        allowProposedApi: true,
        ...(theme ? { theme } : {}),
      });

      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new SearchAddon());
      term.loadAddon(new SerializeAddon());

      const unicode11Addon = new Unicode11Addon();
      term.loadAddon(unicode11Addon);
      term.unicode.activeVersion = "11";

      term.open(containerRef.current!);
      fitAddon.fit();

      // Auto-refit terminal when container resizes
      resizeObserver = new ResizeObserver(() => {
        fitAddon?.fit();
      });
      resizeObserver.observe(containerRef.current!);

      // Addons that require a DOM/canvas context must load after open()
      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => webglAddon.dispose());
        term.loadAddon(webglAddon);
      } catch (e) {
        console.warn("WebGL addon failed, using DOM renderer", e);
      }

      try {
        term.loadAddon(new ClipboardAddon());
      } catch (e) {
        console.warn("Clipboard addon failed", e);
      }

      try {
        term.loadAddon(new ImageAddon());
      } catch (e) {
        console.warn("Image addon failed", e);
      }


      

      termRef.current = term;

      // Intercept app-level shortcuts before the terminal swallows them.
      // return false → prevent xterm from processing the key
      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (!e.metaKey) return true; // let terminal handle all non-Cmd keys

        const isAppShortcut = (() => {
          switch (e.key) {
            case "t":
            case "k":
            case "d":
            case "D":
            case "w":
            case "W":
            case "\\":
            case "=":
            case "-":
            case "0":
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
          return false; // prevent xterm from processing this key
        }

        return true; // let terminal handle other Cmd combos
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
      resizeObserver?.disconnect();
      fitAddon?.dispose();
      termRef.current = null;
      if (term) {
        invoke("pty_close", { paneId });
        term.dispose();
      }
    };
  }, [paneId, cwd, theme]);

  return (
    <div
      ref={containerRef}
      className="terminal-pane-container"
      style={{
        width: "100%",
        height: "100%",
        overflow: "hidden",
      }}
    />
  );
}
