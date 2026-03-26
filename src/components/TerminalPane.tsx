import { useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { useThemeStore } from "../store/theme-store";
import { useTerminalLifecycle } from "../hooks/useTerminalLifecycle";
import styles from "./TerminalPane.module.css";

interface TerminalPaneProps {
  paneId: string;
  cwd?: string;
}

export function TerminalPane({ paneId, cwd }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const theme = useThemeStore((s) => s.theme);

  const { ptyError } = useTerminalLifecycle(containerRef, paneId, cwd, theme);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", minHeight: 0 }}>
      <div
        ref={containerRef}
        className={styles.container}
        style={{
          width: "100%",
          height: "100%",
          minHeight: 0,
          overflow: "hidden",
        }}
      />
      {ptyError && (
        <div className={styles.errorOverlay}>
          <div className={styles.errorBox}>
            <h2 className={styles.errorTitle}>Terminal failed to start</h2>
            <p className={styles.errorMessage}>{ptyError}</p>
            <p className={styles.errorHint}>
              Manor may need Full Disk Access or Developer Tools permissions.
              Open <strong>System Settings &rarr; Privacy &amp; Security</strong> and
              grant access to Manor under <strong>Full Disk Access</strong> or{" "}
              <strong>Developer Tools</strong>.
            </p>
            <button
              className={styles.errorButton}
              onClick={() => {
                window.electronAPI.shell.openExternal(
                  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
                );
              }}
            >
              Open Privacy &amp; Security
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
