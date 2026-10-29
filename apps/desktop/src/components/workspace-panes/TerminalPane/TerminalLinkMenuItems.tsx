import * as ContextMenu from "@radix-ui/react-context-menu";
import AppWindow from "lucide-react/dist/esm/icons/app-window";
import Columns2 from "lucide-react/dist/esm/icons/columns-2";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import Copy from "lucide-react/dist/esm/icons/copy";
import FileCode from "lucide-react/dist/esm/icons/file-code";
import FilePlus from "lucide-react/dist/esm/icons/file-plus";
import { useAppStore } from "../../../store/app-store";
import { openExternal } from "../../../lib/open-external";
import {
  openFileBeside,
  openFileInNewTab,
  splitDirectionBeside,
} from "../../../lib/open-in-file-pane";
import type { TerminalFileLink } from "../../../terminal/link-hover";
import styles from "./TerminalPane.module.css";

/** The click that already opens a link in the default browser. */
const OPEN_LINK_CLICK =
  typeof navigator !== "undefined" && /Mac/.test(navigator.platform)
    ? "⌘ Click"
    : "Ctrl Click";

type TerminalLinkMenuItemsProps = {
  url: string;
  paneId: string;
  containerRef: React.RefObject<HTMLElement | null>;
};

/**
 * The context menu's items for a right-clicked link: Manor's browser, as a
 * new tab or a split beside this terminal, then the default browser and the
 * clipboard. Desktop only; a browser pane needs Electron's `<webview>`.
 */
export function TerminalLinkMenuItems({ url, paneId, containerRef }: TerminalLinkMenuItemsProps) {
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
        <span className={styles.contextMenuHint}>{OPEN_LINK_CLICK}</span>
      </ContextMenu.Item>
      <ContextMenu.Item
        className={styles.contextMenuItem}
        onSelect={() => void navigator.clipboard.writeText(url)}
      >
        <Copy size={14} />
        Copy Link
      </ContextMenu.Item>

      <ContextMenu.Separator className={styles.contextMenuSeparator} />
    </>
  );
}

type TerminalFileLinkMenuItemsProps = {
  link: TerminalFileLink;
  paneId: string;
  containerRef: React.RefObject<HTMLElement | null>;
};

/** `src/foo.ts:12` as printed back: the path and, if it named one, the line. */
function linkLabel({ path, line, col }: TerminalFileLink): string {
  if (!line) return path;
  return col ? `${path}:${line}:${col}` : `${path}:${line}`;
}

/**
 * The context menu's items for a right-clicked file of the workspace: a file
 * pane beside this terminal (what ⌘/Ctrl-click does), a file pane in a new
 * tab, or the path on the clipboard.
 */
export function TerminalFileLinkMenuItems({
  link,
  paneId,
  containerRef,
}: TerminalFileLinkMenuItemsProps) {
  return (
    <>
      <ContextMenu.Item
        className={styles.contextMenuItem}
        data-testid="terminal-link-open-file-pane"
        onSelect={() =>
          openFileBeside(paneId, link.path, splitDirectionBeside(containerRef.current), link)
        }
      >
        <FileCode size={14} />
        Open in File Pane
        <span className={styles.contextMenuHint}>{OPEN_LINK_CLICK}</span>
      </ContextMenu.Item>
      <ContextMenu.Item
        className={styles.contextMenuItem}
        data-testid="terminal-link-open-file-tab"
        onSelect={() => openFileInNewTab(paneId, link.path, link)}
      >
        <FilePlus size={14} />
        Open in New File Tab
      </ContextMenu.Item>
      <ContextMenu.Item
        className={styles.contextMenuItem}
        onSelect={() => void navigator.clipboard.writeText(linkLabel(link))}
      >
        <Copy size={14} />
        Copy Path
      </ContextMenu.Item>

      <ContextMenu.Separator className={styles.contextMenuSeparator} />
    </>
  );
}
