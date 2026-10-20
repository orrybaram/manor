import * as ContextMenu from "@radix-ui/react-context-menu";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import { useState } from "react";
import { useHostStore } from "../../store/host-store";
import { useProjectStore, type ProjectInfo } from "../../store/project-store";
import { useHostProfileStore } from "../../store/host-profile-store";
import {
  hasHiddenPods,
  newHostTargets,
  transferTargets,
  type NewHostTarget,
  type TransferTarget,
} from "../../lib/transfer-targets";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import styles from "./ProjectItem.module.css";

type ProjectSetUpMenuProps = {
  project: ProjectInfo;
};

/** The "Set up on" submenu of a project's context menu. */
export function ProjectSetUpMenu(props: ProjectSetUpMenuProps) {
  const { project } = props;
  const hosts = useHostStore((s) => s.hosts);
  const projects = useProjectStore((s) => s.projects);
  const setUpOnHost = useProjectStore((s) => s.setUpOnHost);
  const openTransferDialog = useProjectStore((s) => s.openTransferDialog);
  const openInNewHost = useProjectStore((s) => s.openInNewHost);
  const profiles = useHostProfileStore((s) => s.profiles);
  const [showAllHosts, setShowAllHosts] = useState(false);
  const targets = transferTargets(project, projects, hosts, "copy", { showAllHosts });
  const hiddenPods = hasHiddenPods(project, hosts);
  const podTargets = newHostTargets(profiles);

  const choose = (target: TransferTarget) => {
    void setUpOnHost(project.id, target.hostId);
  };

  const choosePod = (target: NewHostTarget) => {
    void openInNewHost({ profileId: target.profileId, sourceProjectId: project.id });
  };

  const firstEnabled =
    targets.find((t) => t.disabledReason === null) ?? targets[0];

  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger
        className={styles.contextMenuItem}
        style={{ display: "flex", alignItems: "center" }}
        disabled={targets.length === 0 && podTargets.length === 0}
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
          {hiddenPods && (
            <ContextMenu.Item
              className={styles.contextMenuItem}
              data-testid="set-up-show-all-hosts"
              onSelect={(e) => {
                // Keep the submenu open so the extra hosts appear in place.
                e.preventDefault();
                setShowAllHosts((v) => !v);
              }}
            >
              {showAllHosts ? "Hide other projects' hosts" : "Show all hosts"}
            </ContextMenu.Item>
          )}
          {podTargets.length > 0 && (
            <>
              {targets.length > 0 && (
                <ContextMenu.Separator className={styles.contextMenuSeparator} />
              )}
              {podTargets.map((target) => (
                <ContextMenu.Item
                  key={target.profileId}
                  className={styles.contextMenuItem}
                  data-testid="set-up-in-new-pod"
                  onSelect={() => choosePod(target)}
                >
                  {target.label}
                </ContextMenu.Item>
              ))}
            </>
          )}
          {firstEnabled && (
            <>
              <ContextMenu.Separator className={styles.contextMenuSeparator} />
              <ContextMenu.Item
                className={styles.contextMenuItem}
                onSelect={() =>
                  openTransferDialog({
                    projectId: project.id,
                    hostId: firstEnabled.hostId,
                    mode: "setUp",
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
