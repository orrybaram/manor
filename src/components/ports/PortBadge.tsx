import { useCallback } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import { useAppStore } from "../../store/app-store";
import styles from "./Ports.module.css";

type PortBadgeProps = {
  port: import("../../electron.d.ts").ActivePort;
};

export function PortBadge(props: PortBadgeProps) {
  const { port } = props;

  const addBrowserTab = useAppStore((s) => s.addBrowserTab);

  const url = port.hostname
    ? `http://${port.hostname}`
    : `http://localhost:${port.port}`;

  const handleOpenInTab = useCallback(() => {
    addBrowserTab(url);
  }, [url, addBrowserTab]);

  const handleOpenExternal = useCallback(
    (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      window.electronAPI.shell.openExternal(url);
    },
    [url],
  );

  const handleKillPort = useCallback(() => {
    window.electronAPI.ports.killPort(port.pid);
  }, [port.pid]);

  // Extract project name from hostname (remove .localhost:port suffix)
  const projectName = port.hostname
    ? port.hostname.replace(/\.localhost(:\d+)?$/, "")
    : null;

  // Determine title and display labels
  const titleText = port.hostname
    ? `Open ${port.hostname}`
    : `Open localhost:${port.port}`;
  const displayProcess = projectName || port.processName;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          className={styles.portBadge}
          title={titleText}
          onClick={handleOpenInTab}
          style={{ cursor: "pointer" }}
        >
          <span className={styles.portNumber}>{port.port}</span>
          <span className={styles.portProcess}>{displayProcess}</span>
          <div role="button" onClick={handleOpenExternal}>
            <ExternalLink size={12} className={styles.portOpen} />
          </div>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={styles.contextMenu}>
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={handleOpenInTab}
          >
            Open in Browser Tab
          </ContextMenu.Item>
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={handleOpenExternal}
          >
            Open in Default Browser
          </ContextMenu.Item>
          <ContextMenu.Separator className={styles.contextMenuSeparator} />
          <ContextMenu.Item
            className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
            onSelect={handleKillPort}
          >
            Kill Port
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
