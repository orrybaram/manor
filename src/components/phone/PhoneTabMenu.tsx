import * as ContextMenu from "@radix-ui/react-context-menu";
import { find } from "../../lib/workspace-directory";
import { parseWorkspaceKey } from "../../lib/workspace-key";
import { selectPaneChatAgent } from "../../lib/pane-agent";
import {
  selectActiveWorkspaceKey,
  selectPaneContentType,
  useAppStore,
} from "../../store/app-store";
import { useAgentStore } from "../../store/agent-store";
import { useProjectStore } from "../../store/project-store";
import { useWorkspaceProjectId } from "../../hooks/useWorkspaceProjectId";
import { requestUi } from "../../utils/ui-request";
import styles from "./PhoneTabMenu.module.css";

type PhoneTabMenuContentProps = {
  /** The tab's focused pane. */
  paneId: string | undefined;
  canClose: boolean;
  onClose: () => void;
  onCloseAutoFocus: (e: Event) => void;
};

/**
 * A tab's long-press menu on a phone: renaming the tab's agent or the
 * workspace, copying the branch, and closing the tab. The desk's panel and
 * window moves have no meaning on a single-panel phone. Only mounted while
 * open, so its store reads cost nothing the rest of the time. A rename is a
 * UI request `PhoneChrome` answers with its dialog: this menu unmounts as
 * the item closes it.
 */
export function PhoneTabMenuContent(props: PhoneTabMenuContentProps) {
  const { paneId, canClose, onClose, onCloseAutoFocus } = props;

  const workspaceKey = useAppStore(selectActiveWorkspaceKey);
  const contentType = useAppStore((s) =>
    paneId ? selectPaneContentType(s, paneId) : null,
  );
  const agent = useAgentStore((s) =>
    selectPaneChatAgent(s.agents, paneId, contentType),
  );
  const projectId = useWorkspaceProjectId(workspaceKey);
  const ws = useProjectStore((s) =>
    workspaceKey ? find(s.projects, workspaceKey)?.workspace : undefined,
  );

  // The main checkout keeps its name, as in the sidebar.
  const renameWorkspace =
    projectId && workspaceKey && ws && !ws.isMain
      ? { projectId, path: parseWorkspaceKey(workspaceKey).path }
      : null;
  const branch = ws?.branch;
  const prUrl = ws?.pr?.url;
  const anyAboveClose = !!(agent || renameWorkspace || branch || prUrl);

  return (
    <ContextMenu.Content
      className={styles.menu}
      data-testid="phone-tab-menu"
      onCloseAutoFocus={onCloseAutoFocus}
    >
      {agent && (
        <ContextMenu.Item
          className={styles.item}
          data-testid="phone-tab-rename-agent"
          onSelect={() => requestUi({ type: "rename-agent", agentId: agent.id })}
        >
          Rename Agent
        </ContextMenu.Item>
      )}
      {renameWorkspace && (
        <ContextMenu.Item
          className={styles.item}
          data-testid="phone-tab-rename-workspace"
          onSelect={() => requestUi({ type: "rename-workspace", ...renameWorkspace })}
        >
          Rename Workspace
        </ContextMenu.Item>
      )}
      {branch && (
        <ContextMenu.Item
          className={styles.item}
          data-testid="phone-tab-copy-branch"
          onSelect={() => void navigator.clipboard.writeText(branch)}
        >
          Copy Branch Name
        </ContextMenu.Item>
      )}
      {prUrl && (
        <ContextMenu.Item
          className={styles.item}
          data-testid="phone-tab-copy-pr"
          onSelect={() => void navigator.clipboard.writeText(prUrl)}
        >
          Copy Pull Request Link
        </ContextMenu.Item>
      )}
      {canClose && (
        <>
          {anyAboveClose && <ContextMenu.Separator className={styles.separator} />}
          <ContextMenu.Item
            className={styles.item}
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
