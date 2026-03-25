import { useCallback } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { ExternalLink } from "lucide-react";
import { useAppStore } from "../store/app-store";
import styles from "./Sidebar.module.css";

export function PortBadge({
  port,
}: {
  port: import("../electron.d.ts").ActivePort;
}) {
  const addBrowserSession = useAppStore((s) => s.addBrowserSession);

  const url = port.hostname
    ? `http://${port.hostname}`
    : `http://localhost:${port.port}`;

  const handleOpenInTab = useCallback(() => {
    addBrowserSession(url);
  }, [url, addBrowserSession]);

  const handleOpenExternal = useCallback(() => {
    window.electronAPI.shell.openExternal(url);
  }, [url]);

  // Extract project name from hostname (remove .localhost suffix)
  const projectName = port.hostname
    ? port.hostname.replace(/\.localhost$/, "")
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
          <ExternalLink size={12} className={styles.portOpen} />
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
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
