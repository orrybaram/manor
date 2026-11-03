import * as ContextMenu from "@radix-ui/react-context-menu";
import AppWindow from "lucide-react/dist/esm/icons/app-window";
import Columns2 from "lucide-react/dist/esm/icons/columns-2";
import Copy from "lucide-react/dist/esm/icons/copy";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import { openExternal } from "../../lib/open-external";
import { splitDirectionBeside } from "../../lib/open-in-file-pane";
import { useAppStore } from "../../store/app-store";
import styles from "./TerminalPane/TerminalPane.module.css";

type LinkMenuItemsProps = {
  url: string;
  paneId: string;
  containerRef: React.RefObject<HTMLElement | null>;
  /** The click that already opens this link in the default browser. */
  openClickHint: string;
};

/**
 * A context menu's items for a right-clicked URL in a pane: Manor's browser,
 * as a new tab or a split beside the pane, then the default browser and the
 * clipboard. Desktop only; a browser pane needs Electron's `<webview>`.
 */
export function LinkMenuItems({ url, paneId, containerRef, openClickHint }: LinkMenuItemsProps) {
  const addBrowserTab = useAppStore((s) => s.addBrowserTab);
  const splitPaneAt = useAppStore((s) => s.splitPaneAt);

  const splitDir = () => splitDirectionBeside(containerRef.current);

  return (
    <>
      <ContextMenu.Item
        className={styles.contextMenuItem}
        onSelect={() => addBrowserTab(url)}
      >
        <AppWindow size={14} />
        Open in New Browser Tab
      </ContextMenu.Item>
      <ContextMenu.Item
        className={styles.contextMenuItem}
        onSelect={() => splitPaneAt(paneId, splitDir(), "second", { contentType: "browser", url })}
      >
        <Columns2 size={14} />
        Open in Browser Split
      </ContextMenu.Item>

      <ContextMenu.Separator className={styles.contextMenuSeparator} />

      <ContextMenu.Item
        className={styles.contextMenuItem}
        onSelect={() => openExternal(url)}
      >
        <ExternalLink size={14} />
        Open in Default Browser
        <span className={styles.contextMenuHint}>{openClickHint}</span>
      </ContextMenu.Item>
      <ContextMenu.Item
        className={styles.contextMenuItem}
        onSelect={() => void navigator.clipboard.writeText(url)}
      >
        <Copy size={14} />
        Copy Link
      </ContextMenu.Item>
    </>
  );
}
