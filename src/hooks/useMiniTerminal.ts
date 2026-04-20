import { useCallback, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { terminalOptions, themeToXterm } from "../terminal/config";
import { useThemeStore } from "../store/theme-store";

export interface UseMiniTerminalOptions {
  containerRef: React.RefObject<HTMLDivElement | null>;
  sessionId: string;
  cwd: string | null;
  command: string | null;
  interactive?: boolean;
  onOutput?: (data: string) => void;
  onExit?: () => void;
  /** If true, appends "; exit" to the command so the shell exits after completion */
  exitOnComplete?: boolean;
  /**
   * Attach to an existing PTY session instead of creating a new one.
   * When true: start() skips pty.create; cleanup() skips pty.close.
   * All other setup (xterm open, output/exit subscriptions) still runs so
   * the user sees live output while the view is mounted.
   */
  attach?: boolean;
}

export interface UseMiniTerminalReturn {
  start: () => Promise<void>;
  cleanup: () => void;
  termRef: React.RefObject<Terminal | null>;
}

export function useMiniTerminal(
  options: UseMiniTerminalOptions,
): UseMiniTerminalReturn {
  const {
    containerRef,
    sessionId,
    cwd,
    command,
    interactive = false,
    onOutput,
    onExit,
    exitOnComplete = false,
    attach = false,
  } = options;

  const theme = useThemeStore((s) => s.theme);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<{ fit(): void; dispose(): void } | null>(null);
  const paneIdRef = useRef<string>("");
  const cleanupFnsRef = useRef<(() => void)[]>([]);

  const cleanup = useCallback(() => {
    cleanupFnsRef.current.forEach((fn) => fn());
    cleanupFnsRef.current = [];
    if (paneIdRef.current) {
      if (!attach) {
        window.electronAPI.pty.close(paneIdRef.current);
      }
      paneIdRef.current = "";
    }
    if (termRef.current) {
      termRef.current.dispose();
      termRef.current = null;
    }
    fitRef.current = null;
  }, [attach]);

  const start = useCallback(async () => {
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ]);
    await import("@xterm/xterm/css/xterm.css");

    paneIdRef.current = sessionId;

    // Wait for DOM to update with the terminal container
    await new Promise((r) => requestAnimationFrame(r));

    const container = containerRef.current;
    if (!container) return;

    const xtermTheme = theme ? themeToXterm(theme) : undefined;

    const term = new Terminal(
      terminalOptions({
        theme: xtermTheme,
        scrollback: 1000,
        cursorBlink: true,
        cursorStyle: "underline",
        fontSize: 12,
      }),
    );
    termRef.current = term;

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);

    term.open(container);
    fit.fit();

    // Forward user input to PTY if interactive
    if (interactive) {
      const unsubData = term.onData((data) => {
        if (paneIdRef.current) {
          window.electronAPI.pty.write(paneIdRef.current, data);
        }
      });
      cleanupFnsRef.current.push(() => unsubData.dispose());
    }

    const cols = term.cols;
    const rows = term.rows;

    if (!attach) {
      await window.electronAPI.pty.create(sessionId, cwd, cols, rows);
    }

    let commandSent = false;
    const cmdToSend = command && exitOnComplete ? `${command}; exit` : command;

    const sendCommand = () => {
      if (commandSent || !cmdToSend) return;
      commandSent = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      window.electronAPI.pty.write(sessionId, cmdToSend + "\r");
    };

    // Wait for the shell prompt before sending the command.
    // Manor's custom .zshrc emits OSC 7 (CWD) via a precmd hook,
    // which fires right before the prompt — so the first CWD event
    // means ZLE is ready for input.
    // In attach mode the PTY and its command are owned by an upstream
    // orchestrator — the view is a pure observer and must not re-send.
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    if (cmdToSend && !attach) {
      const unsubCwd = window.electronAPI.pty.onCwd(sessionId, () => {
        unsubCwd();
        sendCommand();
      });
      cleanupFnsRef.current.push(unsubCwd);

      // Fallback: if no CWD event arrives (e.g. non-zsh shell),
      // send after a generous timeout.
      fallbackTimer = setTimeout(() => {
        fallbackTimer = null;
        sendCommand();
      }, 3000);
      cleanupFnsRef.current.push(() => {
        if (fallbackTimer) clearTimeout(fallbackTimer);
      });
    }

    const unsubOutput = window.electronAPI.pty.onOutput(
      sessionId,
      (data: string) => {
        term.write(data);
        onOutput?.(data);
      },
    );
    cleanupFnsRef.current.push(unsubOutput);

    const unsubExit = window.electronAPI.pty.onExit(sessionId, () => {
      onExit?.();
    });
    cleanupFnsRef.current.push(unsubExit);
  }, [sessionId, cwd, command, interactive, onOutput, onExit, exitOnComplete, attach, theme, containerRef]);

  return { start, cleanup, termRef };
}
