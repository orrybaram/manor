import { useRef, useState, type KeyboardEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import EllipsisVertical from "lucide-react/dist/esm/icons/ellipsis-vertical";
import MessageSquare from "lucide-react/dist/esm/icons/message-square";
import SquareTerminal from "lucide-react/dist/esm/icons/square-terminal";
import GitCompareArrows from "lucide-react/dist/esm/icons/git-compare-arrows";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Bot from "lucide-react/dist/esm/icons/bot";
import { Button } from "../ui/Button/Button";
import { useLayoutMode } from "../../hooks/useLayoutMode";
import { isHomePath } from "../../lib/home-path";
import { find } from "../../lib/workspace-directory";
import { parseWorkspaceKey } from "../../lib/workspace-key";
import {
  selectActiveWorkspaceKey,
  selectFocusedPaneOfActiveTab,
  selectPaneContentType,
  useAppStore,
} from "../../store/app-store";
import { useAgentStore } from "../../store/agent-store";
import { useProjectStore } from "../../store/project-store";
import { chatTranscriptPath, pickPaneAgent } from "./ChatPane/chat-view";
import { usePaneChatView, usePaneChatViewStore } from "./ChatPane/usePaneChatView";
import { RenameDialog } from "./RenameDialog";
import styles from "./Phone.module.css";

type MenuTargets = {
  /** The focused pane, when it can be read as a chat — the same rule
   *  `LeafPane` uses to offer one (ADR-215 D7): a Claude agent with a local
   *  transcript, and not a diff or browser pane. */
  chatPaneId: string | null;
  /** The focused pane's agent, to rename. */
  agentId: string | null;
  /** The active workspace's diff can be opened: a project workspace (not
   *  Home), and the diff is not already what the phone is looking at. */
  canOpenDiff: boolean;
  /** The active workspace can be renamed: a project's worktree — the main
   *  checkout keeps its name, as in the sidebar. */
  renameWorkspace: { projectId: string; path: string } | null;
};

const NO_TARGETS: MenuTargets = {
  chatPaneId: null,
  agentId: null,
  canOpenDiff: false,
  renameWorkspace: null,
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
  const hasChat = useAgentStore((s) =>
    agentId !== null
      ? chatTranscriptPath(s.agents.find((a) => a.id === agentId) ?? null) !== null
      : false,
  );
  // A Claude agent the phone just started has the chat before its transcript.
  const chatStarting = usePaneChatViewStore((s) =>
    paneId !== null && contentType !== "diff" && contentType !== "browser"
      ? paneId in s.starting
      : false,
  );
  // Strings, so the selectors are stable across unrelated store changes.
  const renameProjectId = useProjectStore((s) => {
    if (!workspaceKey) return null;
    const found = find(s.projects, workspaceKey);
    return found && !found.workspace.isMain ? found.project.id : null;
  });

  if (!workspaceKey) return NO_TARGETS;
  const { path } = parseWorkspaceKey(workspaceKey);
  return {
    chatPaneId: hasChat || chatStarting ? paneId : null,
    agentId,
    canOpenDiff: !isHomePath(path) && contentType !== "diff",
    renameWorkspace: renameProjectId ? { projectId: renameProjectId, path } : null,
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

type Renaming = "workspace" | "agent" | null;

/**
 * The phone top bar's overflow menu: the focused pane's Chat | Terminal
 * switch, the workspace's diff, and renaming the workspace or the focused
 * pane's agent — each only when it applies. Not rendered when none does.
 * Radix `Popover` closes it on Escape and an outside tap; every item closes
 * it too.
 */
export function PhoneOverflowMenu() {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<Renaming>(null);
  const { chatPaneId, agentId, canOpenDiff, renameWorkspace } = useMenuTargets();
  // An item hands focus to whatever it opens (the rename field); focus
  // going back to the trigger would take it away again. Escape and an
  // outside tap still return it.
  const chose = useRef(false);
  const close = () => {
    chose.current = true;
    setOpen(false);
  };

  // Read when the dialog opens, not subscribed to: the field starts from the
  // name as it is now.
  const workspaceName = (): string => {
    if (!renameWorkspace) return "";
    const ws = useProjectStore
      .getState()
      .projects.find((p) => p.id === renameWorkspace.projectId)
      ?.workspaces.find((w) => w.path === renameWorkspace.path);
    return ws?.name || ws?.branch || "";
  };
  const agentName = (): string =>
    useAgentStore.getState().agents.find((a) => a.id === agentId)?.name ?? "";

  const hasItems =
    chatPaneId !== null || agentId !== null || canOpenDiff || renameWorkspace !== null;

  return (
    <>
      {hasItems && (
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
                {renameWorkspace !== null && (
                  <Button
                    variant="ghost"
                    role="menuitem"
                    className={styles.overflowItem}
                    data-testid="phone-overflow-rename-workspace"
                    onClick={() => {
                      close();
                      setRenaming("workspace");
                    }}
                  >
                    <Pencil size={16} />
                    Rename workspace
                  </Button>
                )}
                {agentId !== null && (
                  <Button
                    variant="ghost"
                    role="menuitem"
                    className={styles.overflowItem}
                    data-testid="phone-overflow-rename-agent"
                    onClick={() => {
                      close();
                      setRenaming("agent");
                    }}
                  >
                    <Bot size={16} />
                    Rename agent
                  </Button>
                )}
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}
      <RenameDialog
        open={renaming === "workspace" && renameWorkspace !== null}
        title="Rename Workspace"
        description="Leave it empty to go back to the branch name."
        initialName={renaming === "workspace" ? workspaceName() : ""}
        placeholder="Workspace name"
        onConfirm={(name) => {
          if (!renameWorkspace) return;
          void useProjectStore
            .getState()
            .renameWorkspace(renameWorkspace.projectId, renameWorkspace.path, name);
        }}
        onOpenChange={(next) => {
          if (!next) setRenaming(null);
        }}
      />
      <RenameDialog
        open={renaming === "agent" && agentId !== null}
        title="Rename Agent"
        description="Leave it empty to go back to the agent's own title."
        initialName={renaming === "agent" ? agentName() : ""}
        placeholder="Agent name"
        onConfirm={(name) => {
          if (agentId) void useAgentStore.getState().renameAgent(agentId, name);
        }}
        onOpenChange={(next) => {
          if (!next) setRenaming(null);
        }}
      />
    </>
  );
}
