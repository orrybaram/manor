import * as Dialog from "@radix-ui/react-dialog";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ManorLogo } from "../../ui/ManorLogo";
import { Button } from "../../ui/Button/Button";
import { useUpdaterStore } from "../../../store/updater-store";
import { relativeLong } from "../../../utils/relative-time";
import changelogSource from "../../../../CHANGELOG.md?raw";
import styles from "./AboutModal.module.css";

/**
 * The changelog ships with the build, so what the modal shows always matches
 * the version running. Its own "# Changelog" title is dropped — the section
 * heading above the scroller already says as much.
 */
const CHANGELOG = changelogSource.replace(/^#\s+Changelog\s*\n/, "").trim();

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
      : `Last checked: ${relativeLong(lastChecked)}`;

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
                    onClick={() => window.electronAPI.updater.quitAndInstall()}
                  >
                    Restart
                  </Button>
                </div>
              )}
            </div>
          )}
          <div className={styles.divider} />
          <div className={styles.changelogLabel}>Changelog</div>
          <div className={styles.changelog}>
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => (
                  <a
                    href={href}
                    title={href}
                    onClick={(e) => {
                      e.preventDefault();
                      if (href) window.electronAPI.shell.openExternal(href);
                    }}
                  >
                    {children}
                  </a>
                ),
              }}
            >
              {CHANGELOG}
            </Markdown>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
