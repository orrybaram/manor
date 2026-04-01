import { useState, useCallback, useRef } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import Github from "lucide-react/dist/esm/icons/github";
import X from "lucide-react/dist/esm/icons/x";
import Download from "lucide-react/dist/esm/icons/download";
import Check from "lucide-react/dist/esm/icons/check";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw";
import { MiniTerminal, type MiniTerminalHandle } from "../ui/MiniTerminal";
import styles from "../EmptyState.module.css";

const STORAGE_KEY = "manor:github-nudge-dismissed";

type Phase = "idle" | "installing" | "authenticating" | "done" | "error";

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
  const phaseRef = useRef<Phase>("idle");
  const terminalHandleRef = useRef<MiniTerminalHandle | null>(null);
  const authCompleteRef = useRef(false);
  const sessionIdRef = useRef("");

  const handleDismiss = useCallback(() => {
    if (phaseRef.current === "done") {
      onInstalled?.();
    }
    setDismissed(true);
    try {
      localStorage.setItem(STORAGE_KEY, "true");
    } catch {
      // ignore
    }
  }, [onInstalled]);

  const finishAuth = useCallback(() => {
    if (authCompleteRef.current) return;
    authCompleteRef.current = true;
    terminalHandleRef.current?.cleanup();
    setPhase("done");
    phaseRef.current = "done";
  }, []);

  const handleOutput = useCallback(
    (data: string) => {
      if (
        data.includes("Logged in as") ||
        data.includes("already logged in")
      ) {
        finishAuth();
      }
    },
    [finishAuth],
  );

  const handleExit = useCallback(() => {
    if (authCompleteRef.current) return;
    window.electronAPI.github.checkStatus().then((status) => {
      if (status.installed && status.authenticated) {
        finishAuth();
      } else {
        setPhase("error");
        phaseRef.current = "error";
      }
    });
  }, [finishAuth]);

  const startInstall = useCallback(() => {
    authCompleteRef.current = false;
    sessionIdRef.current = `gh-install-${Date.now()}`;
    setPhase("installing");
    phaseRef.current = "installing";
    // MiniTerminal will render on next frame; start is called via autoStart=false + imperative handle
    requestAnimationFrame(() => {
      terminalHandleRef.current?.start();
    });
  }, []);

  const handleRetry = useCallback(() => {
    terminalHandleRef.current?.cleanup();
    startInstall();
  }, [startInstall]);

  // Cleanup on unmount
  useMountEffect(() => () => terminalHandleRef.current?.cleanup());

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
        {phase !== "idle" && (
          <MiniTerminal
            sessionId={sessionIdRef.current}
            cwd={null}
            command="brew install gh && clear && gh auth login"
            interactive={true}
            onOutput={handleOutput}
            onExit={handleExit}
            autoStart={false}
            handleRef={terminalHandleRef}
            className={styles.nudgeTerminal}
          />
        )}
      </div>
    </div>
  );
}
