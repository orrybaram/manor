import * as ContextMenu from "@radix-ui/react-context-menu";
import Clipboard from "lucide-react/dist/esm/icons/clipboard";
import ClipboardPaste from "lucide-react/dist/esm/icons/clipboard-paste";
import SquareTerminal from "lucide-react/dist/esm/icons/square-terminal";
import X from "lucide-react/dist/esm/icons/x";
import { useRef, useState, type ReactElement } from "react";
import type { LayoutMode } from "../../../hooks/useLayoutMode";
import { formatCombo } from "../../../lib/keybindings";
import { isWebApp } from "../../../lib/platform";
import type { WorkspaceKey } from "../../../lib/workspace-key";
import { useAppStore } from "../../../store/app-store";
import { useKeybindingsStore } from "../../../store/keybindings-store";
import { LinkMenuItems } from "../../workspace-panes/LinkMenuItems";
import { PaneMenuItems } from "../../workspace-panes/PaneMenuItems";
import paneStyles from "../../workspace-panes/TerminalPane/TerminalPane.module.css";
import { togglePaneChat } from "./pane-chat-toggle";

/** What the text under a right-click would copy: the composer's selection, or the page's. */
function selectedText(): string {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement) {
    return active.value.slice(active.selectionStart, active.selectionEnd);
  }
  return window.getSelection()?.toString() ?? "";
}

/**
 * The http(s) link under a right-click, which a browser pane and the default
 * browser can open. The web app has no browser panes, so it offers none.
 */
function linkAt(target: EventTarget): string | null {
  if (isWebApp() || !(target instanceof Element)) return null;
  const href = target.closest("a[href]")?.getAttribute("href");
  return href && /^https?:\/\//i.test(href) ? href : null;
}

type ChatPaneMenuProps = {
  paneId: string;
  workspaceKey?: WorkspaceKey;
  layout: LayoutMode;
  /** Pastes into the composer; absent while the chat has none to paste into. */
  onPaste?: () => void;
  /** The chat's root element, which must take a ref and event handlers. */
  children: ReactElement;
};

/**
 * A right-click anywhere in a chat: what a right-click in its terminal offers,
 * with Copy and Paste working on the chat's text and composer. Reset Terminal
 * has nothing to reset here, so Show Terminal stands in its place.
 *
 * A touch screen keeps its long-press for selecting text, the way to copy from
 * a chat there.
 */
export function ChatPaneMenu({ paneId, workspaceKey, layout, onPaste, children }: ChatPaneMenuProps) {
  const containerRef = useRef<HTMLElement | null>(null);
  // Taken as the menu opens: the menu takes focus, and the pointer leaves.
  const [selection, setSelection] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const requestClosePaneById = useAppStore((s) => s.requestClosePaneById);
  const toggleCombo = useKeybindingsStore((s) => s.bindings["toggle-pane-chat"]);
  const touch = window.matchMedia?.("(pointer: coarse)").matches ?? false;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        asChild
        disabled={touch}
        style={touch ? { WebkitTouchCallout: "default" } : undefined}
        onContextMenu={(e) => {
          // A popover's portal bubbles here too; it isn't the chat.
          if (!e.currentTarget.contains(e.target as Node)) {
            e.preventDefault();
            return;
          }
          containerRef.current = e.currentTarget;
          setSelection(selectedText());
          setLink(linkAt(e.target));
        }}
      >
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={paneStyles.contextMenu} data-testid="chat-pane-menu">
          {link && (
            <>
              <LinkMenuItems
                url={link}
                paneId={paneId}
                containerRef={containerRef}
                openClickHint="Click"
              />
              <ContextMenu.Separator className={paneStyles.contextMenuSeparator} />
            </>
          )}
          <ContextMenu.Item
            className={paneStyles.contextMenuItem}
            disabled={!selection}
            onSelect={() => void navigator.clipboard.writeText(selection)}
          >
            <Clipboard size={14} />
            Copy
          </ContextMenu.Item>
          {onPaste && (
            <ContextMenu.Item className={paneStyles.contextMenuItem} onSelect={onPaste}>
              <ClipboardPaste size={14} />
              Paste
            </ContextMenu.Item>
          )}

          <ContextMenu.Separator className={paneStyles.contextMenuSeparator} />

          <PaneMenuItems paneId={paneId} workspaceKey={workspaceKey} containerRef={containerRef} />

          <ContextMenu.Separator className={paneStyles.contextMenuSeparator} />

          <ContextMenu.Item
            className={paneStyles.contextMenuItem}
            onSelect={() => togglePaneChat(paneId, layout)}
          >
            <SquareTerminal size={14} />
            Show Terminal
            {toggleCombo && <span className={paneStyles.contextMenuHint}>{formatCombo(toggleCombo)}</span>}
          </ContextMenu.Item>
          <ContextMenu.Item
            className={`${paneStyles.contextMenuItem} ${paneStyles.contextMenuItemDanger}`}
            onSelect={() => requestClosePaneById(paneId)}
          >
            <X size={14} />
            Close Pane
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
