import { useState, useCallback, useRef } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import Github from "lucide-react/dist/esm/icons/github";
import X from "lucide-react/dist/esm/icons/x";
import Download from "lucide-react/dist/esm/icons/download";
import Check from "lucide-react/dist/esm/icons/check";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw";
import type { Terminal } from "@xterm/xterm";
import { terminalOptions } from "../../terminal/config";
import { useThemeStore, type Theme } from "../../store/theme-store";
import styles from "../EmptyState.module.css";

const STORAGE_KEY = "manor:github-nudge-dismissed";

type Phase = "idle" | "installing" | "authenticating" | "done" | "error";

function themeToXterm(t: Theme) {
  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    cursorAccent: t.cursorAccent,
    selectionBackground: t.selectionBackground,
    selectionForeground: t.selectionForeground,
    black: t.black,
    red: t.red,
    green: t.green,
    yellow: t.yellow,
    blue: t.blue,
    magenta: t.magenta,
    cyan: t.cyan,
    white: t.white,
    brightBlack: t.brightBlack,
    brightRed: t.brightRed,
    brightGreen: t.brightGreen,
    brightYellow: t.brightYellow,
    brightBlue: t.brightBlue,
    brightMagenta: t.brightMagenta,
    brightCyan: t.brightCyan,
    brightWhite: t.brightWhite,
  };
}

type GitHubNudgeProps = {
  onInstalled?: () => void;
};

export function GitHubNudge(props: GitHubNudgeProps) {
  const { onInstalled } = props;

  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [phase, setPhase] = useState<Phase>("idle");
  const theme = useThemeStore((s) => s.theme);

  const termContainerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<{ fit(): void; dispose(): void } | null>(null);
  const paneIdRef = useRef<string>("");
  const cleanupRef = useRef<(() => void)[]>([]);
  const phaseRef = useRef<Phase>("idle");

  const handleDismiss = useCallback(() => {
    // If success state, trigger the refresh before dismissing
    if (phaseRef.current === "done") {
      onInstalled?.();
    }
    setDismissed(true);
    try {
      localStorage.setItem(STORAGE_KEY, "true");
    } catch {
      // ignore — dismissal still works in memory
    }
  }, [onInstalled]);

  const cleanup = useCallback(() => {
    cleanupRef.current.forEach((fn) => fn());
    cleanupRef.current = [];
    if (paneIdRef.current) {
      window.electronAPI.pty.close(paneIdRef.current);
      paneIdRef.current = "";
    }
    if (termRef.current) {
      termRef.current.dispose();
      termRef.current = null;
    }
    fitRef.current = null;
  }, []);

  useMountEffect(() => cleanup);

  const startInstall = useCallback(async () => {
    setPhase("installing");
    phaseRef.current = "installing";

    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ]);
    await import("@xterm/xterm/css/xterm.css");

    const paneId = `gh-install-${Date.now()}`;
    paneIdRef.current = paneId;

    // Wait for DOM to update with the terminal container
    await new Promise((r) => requestAnimationFrame(r));

    const container = termContainerRef.current;
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

    // Forward user input to PTY for interactive auth flow
    const unsubData = term.onData((data) => {
      if (paneIdRef.current) {
        window.electronAPI.pty.write(paneIdRef.current, data);
      }
    });
    cleanupRef.current.push(() => unsubData.dispose());

    const cols = term.cols;
    const rows = term.rows;

    await window.electronAPI.pty.create(paneId, null, cols, rows);

    let commandSent = false;
    let authComplete = false;

    const finishAuth = () => {
      if (authComplete) return;
      authComplete = true;
      // Clean up the terminal and PTY
      if (termRef.current) {
        termRef.current.dispose();
        termRef.current = null;
      }
      fitRef.current = null;
      window.electronAPI.pty.close(paneId);
      paneIdRef.current = "";
      setPhase("done");
      phaseRef.current = "done";
    };

    const unsubOutput = window.electronAPI.pty.onOutput(
      paneId,
      (data: string) => {
        term.write(data);
        // Send the command once the shell has produced its first output (prompt)
        if (!commandSent) {
          commandSent = true;
          window.electronAPI.pty.write(
            paneId,
            "brew install gh && clear && gh auth login\r",
          );
        }
        // Detect auth completion from gh auth login output
        if (
          data.includes("Logged in as") ||
          data.includes("already logged in")
        ) {
          finishAuth();
        }
      },
    );
    cleanupRef.current.push(unsubOutput);

    const unsubExit = window.electronAPI.pty.onExit(paneId, () => {
      if (authComplete) return;
      // Shell exited without auth completing — check status as fallback
      window.electronAPI.github.checkStatus().then((status) => {
        if (status.installed && status.authenticated) {
          finishAuth();
        } else {
          setPhase("error");
          phaseRef.current = "error";
        }
      });
    });
    cleanupRef.current.push(unsubExit);
  }, [theme]);

  const handleRetry = useCallback(() => {
    cleanup();
    startInstall();
  }, [cleanup, startInstall]);

  if (dismissed) return null;

  if (phase === "done") {
    return (
      <div className={`${styles.nudge} ${styles.nudgeSuccess}`}>
        <span className={styles.nudgeSuccessIcon}>
          <Check size={16} />
        </span>
        <div className={styles.nudgeContent}>
          <span className={styles.nudgeText}>
            GitHub CLI installed and authenticated!
          </span>
        </div>
        <button
          className={styles.nudgeDismiss}
          onClick={handleDismiss}
          title="Close"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className={styles.nudgeWrapper}>
      <div className={styles.nudge}>
        <Github size={16} className={styles.nudgeIcon} />
        <div className={styles.nudgeContent}>
          {phase === "authenticating" ? (
            <span className={styles.nudgeText}>
              Authenticate with GitHub to continue
            </span>
          ) : (
            <span className={styles.nudgeText}>
              Install the{" "}
              <button
                className={styles.nudgeLink}
                onClick={() =>
                  window.electronAPI.shell.openExternal(
                    "https://cli.github.com",
                  )
                }
              >
                GitHub CLI
              </button>{" "}
              to see your issues here
            </span>
          )}
        </div>
        {phase === "idle" && (
          <button className={styles.nudgeInstallBtn} onClick={startInstall}>
            <Download size={13} />
            Install
          </button>
        )}
        {phase === "error" && (
          <button className={styles.nudgeInstallBtn} onClick={handleRetry}>
            <RotateCcw size={13} />
            Retry
          </button>
        )}
        <button
          className={styles.nudgeDismiss}
          onClick={handleDismiss}
          title="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
      <div
        className={`${styles.nudgeTerminalWrapper} ${phase !== "idle" ? styles.nudgeTerminalOpen : ""}`}
      >
        <div ref={termContainerRef} className={styles.nudgeTerminal} />
      </div>
    </div>
  );
}
