import * as Dialog from "@radix-ui/react-dialog";
import { ManorLogo } from "../../ui/ManorLogo";
import { Button } from "../../ui/Button/Button";
import { useUpdaterStore } from "../../../store/updater-store";
import styles from "./AboutModal.module.css";

const INSPIRATIONS = [
  { name: "superset", url: "https://github.com/superset-sh/superset" },
  { name: "supacode", url: "https://github.com/supabitapp/supacode" },
  { name: "react-grab", url: "https://github.com/aidenybai/react-grab" },
  { name: "libghostty", url: "https://github.com/ghostty-org/ghostty" },
  { name: "xterm", url: "https://github.com/xtermjs/xterm.js" },
  { name: "t3code", url: "https://github.com/pingdotgg/t3code" },
  { name: "agent-deck", url: "https://github.com/asheshgoplani/agent-deck" },
];

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

type AboutModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function AboutModal(props: AboutModalProps) {
  const { open, onOpenChange } = props;

  const checking = useUpdaterStore((s) => s.checking);
  const lastChecked = useUpdaterStore((s) => s.lastChecked);
  const pending = useUpdaterStore((s) => s.pending);

  const isPackaged = window.electronAPI.env.isPackaged;

  const lastCheckedLabel =
    lastChecked === null
      ? "Last checked: never"
      : `Last checked: ${formatRelativeTime(lastChecked)}`;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog}>
          <Dialog.Title className={styles.title}>Manor</Dialog.Title>
          <div className={styles.logo}>
            <ManorLogo />
          </div>
          <div className={styles.version}>v{__APP_VERSION__}</div>
          {isPackaged && (
            <div className={styles.updateSection}>
              <Button
                variant="secondary"
                size="sm"
                disabled={checking}
                onClick={() => useUpdaterStore.getState().triggerManualCheck()}
              >
                {checking ? "Checking…" : "Check for Updates"}
              </Button>
              <div className={styles.lastChecked}>{lastCheckedLabel}</div>
              {pending !== null && (
                <div className={styles.pendingRow}>
                  <span className={styles.pendingText}>
                    Manor {pending.version} ready to install
                  </span>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() =>
                      window.electronAPI.updater.quitAndInstall()
                    }
                  >
                    Restart
                  </Button>
                </div>
              )}
            </div>
          )}
          <div className={styles.divider} />
          <div className={styles.inspiredLabel}>Inspired by</div>
          <div className={styles.links}>
            {INSPIRATIONS.map((item) => (
              <button
                key={item.name}
                className={styles.link}
                onClick={() =>
                  window.electronAPI.shell.openExternal(item.url)
                }
              >
                {item.name}
              </button>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
