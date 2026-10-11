import * as ContextMenu from "@radix-ui/react-context-menu";
import { find } from "../../lib/workspace-directory";
import { parseWorkspaceKey } from "../../lib/workspace-key";
import {
  selectActiveWorkspaceKey,
  selectPaneContentType,
  useAppStore,
} from "../../store/app-store";
import { useAgentStore } from "../../store/agent-store";
import { useProjectStore } from "../../store/project-store";
import { pickPaneAgent } from "./ChatPane/chat-view";
import { RenameDialog } from "./RenameDialog";
import styles from "../tabbar/TabBar/TabBar.module.css";

/** What a rename from the tab menu acts on, with the name it starts from. */
export type PhoneRenameTarget =
  | { kind: "workspace"; projectId: string; path: string; name: string }
  | { kind: "agent"; agentId: string; name: string };

type PhoneTabMenuContentProps = {
  /** The tab's focused pane. */
  paneId: string | undefined;
  canClose: boolean;
  onClose: () => void;
  onRename: (target: PhoneRenameTarget) => void;
  onCloseAutoFocus: (e: Event) => void;
};

/**
 * A tab's long-press menu on a phone: renaming the tab's agent or the
 * workspace, copying the branch, and closing the tab. The desk's panel and
 * window moves have no meaning on a single-panel phone. Only mounted while
 * open, so its store reads cost nothing the rest of the time.
 */
export function PhoneTabMenuContent(props: PhoneTabMenuContentProps) {
  const { paneId, canClose, onClose, onRename, onCloseAutoFocus } = props;

  const workspaceKey = useAppStore(selectActiveWorkspaceKey);
  const contentType = useAppStore((s) =>
    paneId ? selectPaneContentType(s, paneId) : null,
  );
  const agent = useAgentStore((s) =>
    paneId && contentType !== "diff" && contentType !== "browser"
      ? pickPaneAgent(s.agents, paneId)
      : null,
  );
  const projectId = useProjectStore((s) =>
    workspaceKey ? (find(s.projects, workspaceKey)?.project.id ?? null) : null,
  );
  const ws = useProjectStore((s) =>
    workspaceKey ? find(s.projects, workspaceKey)?.workspace : undefined,
  );
  // The main checkout keeps its name, as in the sidebar.
  const renameWorkspace = projectId && ws && !ws.isMain ? projectId : null;

  return (
    <ContextMenu.Content
      className={styles.contextMenu}
      data-testid="phone-tab-menu"
      onCloseAutoFocus={onCloseAutoFocus}
    >
      {agent && (
        <ContextMenu.Item
          className={styles.contextMenuItem}
          data-testid="phone-tab-rename-agent"
          onSelect={() =>
            onRename({ kind: "agent", agentId: agent.id, name: agent.name ?? "" })
          }
        >
          Rename Agent
        </ContextMenu.Item>
      )}
      {renameWorkspace && workspaceKey && ws && (
        <ContextMenu.Item
          className={styles.contextMenuItem}
          data-testid="phone-tab-rename-workspace"
          onSelect={() =>
            onRename({
              kind: "workspace",
              projectId: renameWorkspace,
              path: parseWorkspaceKey(workspaceKey).path,
              name: ws.name || ws.branch || "",
            })
          }
        >
          Rename Workspace
        </ContextMenu.Item>
      )}
      {ws?.branch && (
        <ContextMenu.Item
          className={styles.contextMenuItem}
          data-testid="phone-tab-copy-branch"
          onSelect={() => void navigator.clipboard.writeText(ws.branch!)}
        >
          Copy Branch Name
        </ContextMenu.Item>
      )}
      {ws?.pr && (
        <ContextMenu.Item
          className={styles.contextMenuItem}
          data-testid="phone-tab-copy-pr"
          onSelect={() => void navigator.clipboard.writeText(ws.pr!.url)}
        >
          Copy Pull Request Link
        </ContextMenu.Item>
      )}
      {canClose && (
        <>
          {(agent || ws) && (
            <ContextMenu.Separator className={styles.contextMenuSeparator} />
          )}
          <ContextMenu.Item
            className={styles.contextMenuItem}
            data-testid="phone-tab-close"
            onSelect={onClose}
          >
            Close Tab
          </ContextMenu.Item>
        </>
      )}
    </ContextMenu.Content>
  );
}

type PhoneRenameDialogProps = {
  target: PhoneRenameTarget;
  onDone: () => void;
};

/** The rename prompt for whatever the tab menu picked. */
export function PhoneRenameDialog(props: PhoneRenameDialogProps) {
  const { target, onDone } = props;

  const workspace = target.kind === "workspace";

  return (
    <RenameDialog
      open
      title={workspace ? "Rename Workspace" : "Rename Agent"}
      description={
        workspace
          ? "Leave it empty to go back to the branch name."
          : "Leave it empty to go back to the agent's own title."
      }
      initialName={target.name}
      placeholder={workspace ? "Workspace name" : "Agent name"}
      onConfirm={(name) => {
        if (target.kind === "workspace") {
          void useProjectStore
            .getState()
            .renameWorkspace(target.projectId, target.path, name);
        } else {
          void useAgentStore.getState().renameAgent(target.agentId, name);
        }
      }}
      onOpenChange={(next) => {
        if (!next) onDone();
      }}
    />
  );
}
