import { useCallback, useRef } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import { Link } from "../ui/Link/Link";
import { useAppStore } from "../../store/app-store";
import {
  isContextMenuKey,
  openContextMenuFromKeyboard,
} from "../../lib/keyboard-context-menu";
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

  // A remote host's port is reached through a port forward (ADR-178 §5):
  // main swaps in the forward's local port before the URL is opened.
  const hostId = port.hostId;
  const withResolvedUrl = useCallback(
    (open: (target: string) => void) => {
      if (!hostId) {
        open(url);
        return;
      }
      window.electronAPI.ports.resolveUrl(url, hostId).then(open, () => open(url));
    },
    [url, hostId],
  );

  const handleOpenInTab = useCallback(() => {
    withResolvedUrl((target) => addBrowserTab(target));
  }, [withResolvedUrl, addBrowserTab]);

  const handleOpenExternal = useCallback(
    (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      withResolvedUrl((target) => window.electronAPI.shell.openExternal(target));
    },
    [withResolvedUrl],
  );

  const handleCopyPublicUrl = useCallback(() => {
    if (!hostId) return;
    window.electronAPI.ports
      .publicUrl(hostId, port.port)
      .then((publicUrl) => {
        if (publicUrl) return window.electronAPI.clipboard.writeText(publicUrl);
      })
      .catch((err: unknown) => {
        console.error("[PortBadge] copy public URL failed:", err);
      });
  }, [hostId, port.port]);

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

  const badgeRef = useRef<HTMLDivElement | null>(null);
  // Set when the badge's context menu was opened via the keyboard, so
  // `onCloseAutoFocus` knows to return focus to the badge; a mouse-opened
  // menu keeps Radix's own default (ADR-175). The badge isn't focusable yet
  // (ticket 8 makes it so) — this handler is ready for when it is.
  const menuOpenedByKeyboard = useRef(false);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          ref={badgeRef}
          className={styles.portBadge}
          title={titleText}
          role="button"
          tabIndex={0}
          aria-label={titleText}
          onClick={handleOpenInTab}
          onKeyDown={(e) => {
            if (isContextMenuKey(e)) {
              e.preventDefault();
              e.stopPropagation();
              menuOpenedByKeyboard.current = true;
              openContextMenuFromKeyboard(e.currentTarget);
              return;
            }
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleOpenInTab();
            }
          }}
          style={{ cursor: "pointer" }}
        >
          <span className={styles.portNumber}>{port.port}</span>
          <span className={styles.portProcess}>{displayProcess}</span>
          <Link
            variant="plain"
            href={url}
            aria-label="Open in default browser"
            onClick={(e) => {
              e.stopPropagation();
              // The href is the port on the remote box; open its forward.
              if (hostId) {
                e.preventDefault();
                handleOpenExternal(e);
              }
            }}
          >
            <ExternalLink size={12} className={styles.portOpen} />
          </Link>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className={styles.contextMenu}
          onCloseAutoFocus={(e) => {
            if (menuOpenedByKeyboard.current) {
              e.preventDefault();
              badgeRef.current?.focus();
            }
            menuOpenedByKeyboard.current = false;
          }}
        >
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
          {port.canCopyPublicUrl && (
            <ContextMenu.Item
              className={styles.contextMenuItem}
              onSelect={handleCopyPublicUrl}
            >
              Copy Public URL
            </ContextMenu.Item>
          )}
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
