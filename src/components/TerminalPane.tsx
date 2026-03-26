import { useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
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
  const [dismissed, setDismissed] = useState(false);

  return (
    <div ref={containerRef} className={styles.container}>
      <Dialog.Root open={!!ptyError && !dismissed} onOpenChange={(open) => { if (!open) setDismissed(true); }}>
        <Dialog.Portal>
          <Dialog.Overlay className={styles.errorOverlay} />
          <Dialog.Content className={styles.errorBox}>
            <Dialog.Title className={styles.errorTitle}>
              Terminal failed to start
            </Dialog.Title>
            <Dialog.Description className={styles.errorMessage}>
              {ptyError}
            </Dialog.Description>
            <p className={styles.errorHint}>
              Manor may need Full Disk Access or Developer Tools permissions.
              Open <strong>System Settings &rarr; Privacy &amp; Security</strong> and
              grant access to Manor under <strong>Full Disk Access</strong> or{" "}
              <strong>Developer Tools</strong>.
            </p>
            <div className={styles.errorActions}>
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
              <Dialog.Close asChild>
                <button className={styles.errorButton}>
                  Dismiss
                </button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
