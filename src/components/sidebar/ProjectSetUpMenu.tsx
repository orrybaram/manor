import * as ContextMenu from "@radix-ui/react-context-menu";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import { useHostStore } from "../../store/host-store";
import { useProjectStore, type ProjectInfo } from "../../store/project-store";
import {
  transferTargets,
  type TransferTarget,
} from "../../lib/transfer-targets";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import styles from "./ProjectItem.module.css";

type ProjectSetUpMenuProps = {
  project: ProjectInfo;
};

/** The "Set up on" submenu of a project's context menu (ADR-214). */
export function ProjectSetUpMenu(props: ProjectSetUpMenuProps) {
  const { project } = props;
  const hosts = useHostStore((s) => s.hosts);
  const projects = useProjectStore((s) => s.projects);
  const setUpOnHost = useProjectStore((s) => s.setUpOnHost);
  const openTransferDialog = useProjectStore((s) => s.openTransferDialog);
  const targets = transferTargets(project, projects, hosts, "copy");

  const choose = (target: TransferTarget) => {
    void setUpOnHost(project.id, target.hostId);
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
        Set up on
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
                    mode: "copy",
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
