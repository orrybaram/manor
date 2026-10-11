import { useRef, useState, type KeyboardEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import EllipsisVertical from "lucide-react/dist/esm/icons/ellipsis-vertical";
import MessageSquare from "lucide-react/dist/esm/icons/message-square";
import SquareTerminal from "lucide-react/dist/esm/icons/square-terminal";
import GitCompareArrows from "lucide-react/dist/esm/icons/git-compare-arrows";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import { refreshState } from "../../bridge/resync";
import { Button } from "../ui/Button/Button";
import { useLayoutMode } from "../../hooks/useLayoutMode";
import { isHomePath } from "../../lib/home-path";
import { parseWorkspaceKey } from "../../lib/workspace-key";
import {
  selectActiveWorkspaceKey,
  selectFocusedPaneOfActiveTab,
  selectPaneContentType,
  useAppStore,
} from "../../store/app-store";
import { useAgentStore } from "../../store/agent-store";
import { chatTranscriptPath, pickPaneAgent } from "./ChatPane/chat-view";
import {
  endMenuHandoff,
  usePaneChatView,
  usePaneChatViewStore,
  usePaneMenuHandoff,
} from "./ChatPane/usePaneChatView";
import styles from "./Phone.module.css";

type MenuTargets = {
  /** The focused pane, when it can be read as a chat — the same rule
   *  `LeafPane` uses to offer one (ADR-215 D7): a Claude agent with a local
   *  transcript, and not a diff or browser pane. */
  chatPaneId: string | null;
  /** That pane's transcript, null while its chat is still starting. */
  chatTranscript: string | null;
  /** The active workspace's diff can be opened: a project workspace (not
   *  Home), and the diff is not already what the phone is looking at. */
  canOpenDiff: boolean;
};

const NO_TARGETS: MenuTargets = {
  chatPaneId: null,
  chatTranscript: null,
  canOpenDiff: false,
};

/**
 * What the menu can act on. Nothing outside phone mode, or while the Tasks
 * surface covers the workspace.
 */
function useMenuTargets(): MenuTargets {
  const phone = useLayoutMode() === "phone";
  const onWorkspace = useAppStore((s) => phone && s.activeSurface !== "tasks");
  const workspaceKey = useAppStore((s) => (onWorkspace ? selectActiveWorkspaceKey(s) : null));
  const paneId = useAppStore((s) =>
    onWorkspace ? selectFocusedPaneOfActiveTab(s) : null,
  );
  const contentType = useAppStore((s) =>
    paneId ? selectPaneContentType(s, paneId) : null,
  );
  const agentId = useAgentStore((s) =>
    paneId !== null && contentType !== "diff" && contentType !== "browser"
      ? (pickPaneAgent(s.agents, paneId)?.id ?? null)
      : null,
  );
  const chatTranscript = useAgentStore((s) =>
    agentId !== null ? chatTranscriptPath(s.agents.find((a) => a.id === agentId) ?? null) : null,
  );
  // A Claude agent the phone just started has the chat before its transcript.
  const chatStarting = usePaneChatViewStore((s) =>
    paneId !== null && contentType !== "diff" && contentType !== "browser"
      ? paneId in s.starting
      : false,
  );

  if (!workspaceKey) return NO_TARGETS;
  const { path } = parseWorkspaceKey(workspaceKey);
  return {
    chatPaneId: chatTranscript !== null || chatStarting ? paneId : null,
    chatTranscript,
    canOpenDiff: !isHomePath(path) && contentType !== "diff",
  };
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
  transcript: string | null;
  onDone: () => void;
};

/** "Show terminal" / "Show chat" for one pane; its own component so the
 *  pane's view is only subscribed to while there is a pane to flip. */
function ViewItem(props: ViewItemProps) {
  const { paneId, transcript, onDone } = props;

  const [view, setView] = usePaneChatView(paneId, transcript);
  const handoff = usePaneMenuHandoff(paneId, transcript);
  const showingChat = view === "chat";

  return (
    <Button
      variant="ghost"
      role="menuitem"
      className={styles.overflowItem}
      data-testid="phone-overflow-view"
      onClick={() => {
        // Under a menu handoff (ADR-218 D3) the terminal is borrowed: ending
        // it is the flip back to the chat, and the stored choice stays.
        if (handoff) endMenuHandoff(paneId);
        else setView(showingChat ? "terminal" : "chat");
        onDone();
      }}
    >
      {showingChat ? <SquareTerminal size={16} /> : <MessageSquare size={16} />}
      {showingChat ? "Show terminal" : "Show chat"}
    </Button>
  );
}

/**
 * The phone top bar's overflow menu: the focused pane's Chat | Terminal
 * switch and the workspace's diff — each only when it applies — and always
 * Refresh. Renaming lives on a tab's long-press menu (`PhoneTabMenu`).
 * Radix `Popover` closes it on Escape and an outside tap; every item closes
 * it too.
 */
export function PhoneOverflowMenu() {
  const [open, setOpen] = useState(false);
  const { chatPaneId, chatTranscript, canOpenDiff } = useMenuTargets();
  // An item hands focus to whatever it opens (the diff, the chat); focus
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
            {chatPaneId !== null && (
              <ViewItem paneId={chatPaneId} transcript={chatTranscript} onDone={close} />
            )}
            {canOpenDiff && (
              <Button
                variant="ghost"
                role="menuitem"
                className={styles.overflowItem}
                data-testid="phone-overflow-diff"
                onClick={() => {
                  close();
                  useAppStore.getState().openOrFocusDiff();
                }}
              >
                <GitCompareArrows size={16} />
                Diff
              </Button>
            )}
            <Button
              variant="ghost"
              role="menuitem"
              className={styles.overflowItem}
              data-testid="overflow-refresh"
              onClick={() => {
                close();
                void refreshState();
              }}
            >
              <RefreshCw size={16} />
              Refresh
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
