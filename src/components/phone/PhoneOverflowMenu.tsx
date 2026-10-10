import { useRef, useState, type KeyboardEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import EllipsisVertical from "lucide-react/dist/esm/icons/ellipsis-vertical";
import MessageSquare from "lucide-react/dist/esm/icons/message-square";
import SquareTerminal from "lucide-react/dist/esm/icons/square-terminal";
import Command from "lucide-react/dist/esm/icons/command";
import { Button } from "../ui/Button/Button";
import { useLayoutMode } from "../../hooks/useLayoutMode";
import {
  selectFocusedPaneOfActiveTab,
  selectPaneContentType,
  useAppStore,
} from "../../store/app-store";
import { useAgentStore } from "../../store/agent-store";
import { chatTranscriptPath, pickPaneAgent } from "./ChatPane/chat-view";
import { usePaneChatView } from "./ChatPane/usePaneChatView";
import styles from "./Phone.module.css";

/**
 * The pane the phone is looking at, when it can be read as a chat — the same
 * rule `LeafPane` uses to offer one (ADR-215 D7): phone mode, a Claude agent
 * with a local transcript, and not a diff or browser pane. Null otherwise,
 * including while the Tasks surface covers the workspace.
 */
function useFocusedChatPaneId(): string | null {
  const phone = useLayoutMode() === "phone";
  const paneId = useAppStore((s) =>
    phone && s.activeSurface !== "tasks" ? selectFocusedPaneOfActiveTab(s) : null,
  );
  const contentType = useAppStore((s) =>
    paneId ? selectPaneContentType(s, paneId) : null,
  );
  const hasChat = useAgentStore((s) =>
    paneId !== null && contentType !== "diff" && contentType !== "browser"
      ? chatTranscriptPath(pickPaneAgent(s.agents, paneId)) !== null
      : false,
  );
  return hasChat ? paneId : null;
}

/** Up / Down / Home / End move between the menu's items. */
function onMenuKeyDown(e: KeyboardEvent<HTMLElement>): void {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(e.key)) return;
  const items = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  );
  if (items.length === 0) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? items.length - 1
        : e.key === "ArrowDown"
          ? (at + 1) % items.length
          : (at - 1 + items.length) % items.length;
  items[next]?.focus();
}

type ViewItemProps = {
  paneId: string;
  onDone: () => void;
};

/** "Show terminal" / "Show chat" for one pane; its own component so the
 *  pane's view is only subscribed to while there is a pane to flip. */
function ViewItem(props: ViewItemProps) {
  const { paneId, onDone } = props;

  const [view, setView] = usePaneChatView(paneId);
  const showingChat = view === "chat";

  return (
    <Button
      variant="ghost"
      role="menuitem"
      className={styles.overflowItem}
      data-testid="phone-overflow-view"
      onClick={() => {
        setView(showingChat ? "terminal" : "chat");
        onDone();
      }}
    >
      {showingChat ? <SquareTerminal size={16} /> : <MessageSquare size={16} />}
      {showingChat ? "Show terminal" : "Show chat"}
    </Button>
  );
}

type PhoneOverflowMenuProps = {
  onOpenPalette: () => void;
};

/**
 * The phone top bar's overflow menu: the focused pane's Chat | Terminal
 * switch (when it has a chat) and the command palette. Radix `Popover`
 * closes it on Escape and an outside tap; every item closes it too.
 */
export function PhoneOverflowMenu(props: PhoneOverflowMenuProps) {
  const { onOpenPalette } = props;

  const [open, setOpen] = useState(false);
  const chatPaneId = useFocusedChatPaneId();
  // An item hands focus to whatever it opens (the palette's input); focus
  // going back to the trigger would take it away again. Escape and an
  // outside tap still return it.
  const chose = useRef(false);
  const close = () => {
    chose.current = true;
    setOpen(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          variant="ghost"
          className={styles.iconButton}
          aria-label="More"
          aria-haspopup="menu"
          data-testid="phone-overflow-button"
        >
          <EllipsisVertical size={18} />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={styles.overflowMenu}
          data-testid="phone-overflow-menu"
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          // A tap opened it; a focus ring on the first item is noise.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            chose.current = false;
          }}
          onCloseAutoFocus={(e) => {
            if (chose.current) e.preventDefault();
          }}
        >
          <div role="menu" aria-label="More" className={styles.overflowList} onKeyDown={onMenuKeyDown}>
            {chatPaneId !== null && <ViewItem paneId={chatPaneId} onDone={close} />}
            <Button
              variant="ghost"
              role="menuitem"
              className={styles.overflowItem}
              data-testid="phone-overflow-palette"
              onClick={() => {
                close();
                onOpenPalette();
              }}
            >
              <Command size={16} />
              Command palette
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
