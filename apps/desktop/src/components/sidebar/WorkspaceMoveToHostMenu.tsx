import * as ContextMenu from "@radix-ui/react-context-menu";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import { useHostStore } from "../../store/host-store";
import type { ProjectInfo } from "../../store/project-store";
import { workspaceMoveTargets } from "../../lib/transfer-targets";
import { requestUi } from "../../utils/ui-request";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import styles from "./ProjectItem.module.css";

type WorkspaceMoveToHostMenuProps = {
  project: ProjectInfo;
  path: string;
};

/**
 * The "Move to Host" submenu of a workspace's context menu: every other
 * host, set up or not. Picking one opens the Move to Host dialog.
 */
export function WorkspaceMoveToHostMenu(props: WorkspaceMoveToHostMenuProps) {
  const { project, path } = props;
  const hosts = useHostStore((s) => s.hosts);
  const targets = workspaceMoveTargets(project, hosts);

  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger
        className={styles.contextMenuItem}
        style={{ display: "flex", alignItems: "center" }}
        disabled={targets.length === 0}
        data-testid="workspace-move-to-host"
      >
        Move to Host
        <ChevronRight size={14} style={{ marginLeft: "auto" }} />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent className={styles.contextMenu} style={{ maxWidth: 260 }}>
          {targets.map((target) => {
            const item = (
              <ContextMenu.Item
                key={target.hostId}
                className={styles.contextMenuItem}
                disabled={target.disabledReason !== null}
                data-testid={`workspace-move-to-host-${target.hostId}`}
                onSelect={() =>
                  requestUi({
                    type: "move-workspace-to-host",
                    projectId: project.id,
                    path,
                    hostId: target.hostId,
                  })
                }
              >
                {target.label}
              </ContextMenu.Item>
            );
            // Disabled items take no pointer events, so the tooltip hangs
            // off a wrapper.
            return target.disabledReason ? (
              <Tooltip key={target.hostId} label={target.disabledReason} side="right">
                <span>{item}</span>
              </Tooltip>
            ) : (
              item
            );
          })}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}
