import * as ContextMenu from "@radix-ui/react-context-menu";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import { useHostStore } from "../../store/host-store";
import { useProjectStore, type ProjectInfo } from "../../store/project-store";
import {
  transferTargets,
  type TransferTarget,
} from "../../lib/transfer-targets";
import type { TransferMode } from "../../electron";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import styles from "./ProjectItem.module.css";

type ProjectTransferMenuProps = {
  project: ProjectInfo;
  mode: TransferMode;
  /** Required for `move`: from `useMoveConfirm`, rendered outside the menu. */
  requestMove?: (target: TransferTarget) => void;
};

/** The "Copy to" / "Move to" submenu of a project's context menu. */
export function ProjectTransferMenu(props: ProjectTransferMenuProps) {
  const { project, mode, requestMove } = props;
  const hosts = useHostStore((s) => s.hosts);
  const projects = useProjectStore((s) => s.projects);
  const transferProject = useProjectStore((s) => s.transferProject);
  const openTransferDialog = useProjectStore((s) => s.openTransferDialog);
  const targets = transferTargets(project, projects, hosts, mode);

  const choose = (target: TransferTarget) => {
    if (mode === "move" && requestMove) requestMove(target);
    else void transferProject(project.id, target.hostId, mode);
  };

  const firstEnabled =
    targets.find((t) => t.disabledReason === null) ?? targets[0];

  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger
        className={styles.contextMenuItem}
        style={{ display: "flex", alignItems: "center" }}
        disabled={targets.length === 0}
      >
        {mode === "copy" ? "Copy to" : "Move to"}
        <ChevronRight size={14} style={{ marginLeft: "auto" }} />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent
          className={styles.contextMenu}
          style={{ maxWidth: 260 }}
        >
          {targets.map((target) => {
            const item = (
              <ContextMenu.Item
                key={target.hostId}
                className={styles.contextMenuItem}
                disabled={target.disabledReason !== null}
                onSelect={() => choose(target)}
              >
                {target.label}
              </ContextMenu.Item>
            );
            // Disabled items take no pointer events, so the tooltip hangs
            // off a wrapper.
            return target.disabledReason ? (
              <Tooltip
                key={target.hostId}
                label={target.disabledReason}
                side="right"
              >
                <span>{item}</span>
              </Tooltip>
            ) : (
              item
            );
          })}
          {firstEnabled && (
            <>
              <ContextMenu.Separator className={styles.contextMenuSeparator} />
              <ContextMenu.Item
                className={styles.contextMenuItem}
                onSelect={() =>
                  openTransferDialog({
                    projectId: project.id,
                    hostId: firstEnabled.hostId,
                    mode,
                    reason: "manual",
                    repoUrl: null,
                    targetDir: "",
                  })
                }
              >
                Choose location…
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}
