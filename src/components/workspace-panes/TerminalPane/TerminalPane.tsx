import { useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as ContextMenu from "@radix-ui/react-context-menu";
import "@xterm/xterm/css/xterm.css";
import Clipboard from "lucide-react/dist/esm/icons/clipboard";
import ClipboardPaste from "lucide-react/dist/esm/icons/clipboard-paste";
import PanelRight from "lucide-react/dist/esm/icons/panel-right";
import PanelLeft from "lucide-react/dist/esm/icons/panel-left";
import PanelBottom from "lucide-react/dist/esm/icons/panel-bottom";
import PanelTop from "lucide-react/dist/esm/icons/panel-top";
import RotateCw from "lucide-react/dist/esm/icons/rotate-cw";
import X from "lucide-react/dist/esm/icons/x";
import { useThemeStore } from "../../../store/theme-store";
import { useTerminalLifecycle } from "../../../hooks/useTerminalLifecycle";
import { useAppStore } from "../../../store/app-store";
import { Row } from "../../ui/Layout/Layout";
import styles from "./TerminalPane.module.css";

type TerminalPaneProps = {
  paneId: string;
  cwd?: string;
};

export function TerminalPane(props: TerminalPaneProps) {
  const { paneId, cwd } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const theme = useThemeStore((s) => s.theme);

  const { ptyError, term, write } = useTerminalLifecycle(containerRef, paneId, cwd, theme);
  const [dismissed, setDismissed] = useState(false);
  const splitPaneAt = useAppStore((s) => s.splitPaneAt);
  const closePaneById = useAppStore((s) => s.closePaneById);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
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
                <Row gap="sm" className={styles.errorActions}>
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
                </Row>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={styles.contextMenu}>
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={() => {
              const sel = term?.getSelection();
              if (sel) navigator.clipboard.writeText(sel);
            }}
          >
            <Clipboard size={14} />
            Copy
          </ContextMenu.Item>
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={() => {
              navigator.clipboard.readText().then((text) => {
                if (text) write(text);
              });
            }}
          >
            <ClipboardPaste size={14} />
            Paste
          </ContextMenu.Item>

          <ContextMenu.Separator className={styles.contextMenuSeparator} />

          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={() => splitPaneAt(paneId, "horizontal", "second")}
          >
            <PanelRight size={14} />
            Split Right
          </ContextMenu.Item>
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={() => splitPaneAt(paneId, "horizontal", "first")}
          >
            <PanelLeft size={14} />
            Split Left
          </ContextMenu.Item>
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={() => splitPaneAt(paneId, "vertical", "second")}
          >
            <PanelBottom size={14} />
            Split Down
          </ContextMenu.Item>
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={() => splitPaneAt(paneId, "vertical", "first")}
          >
            <PanelTop size={14} />
            Split Up
          </ContextMenu.Item>

          <ContextMenu.Separator className={styles.contextMenuSeparator} />

          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={() => {
              if (term) {
                term.reset();
                write("\x1bc");
              }
            }}
          >
            <RotateCw size={14} />
            Reset Terminal
          </ContextMenu.Item>
          <ContextMenu.Item
            className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
            onSelect={() => closePaneById(paneId)}
          >
            <X size={14} />
            Close Terminal
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
