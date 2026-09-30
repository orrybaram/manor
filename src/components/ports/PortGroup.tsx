import { useCallback } from "react";
import { useProjectStore } from "../../store/project-store";
import { type WorkspacePortGroup } from "./usePortsData";
import { find } from "../../lib/workspace-directory";
import { workspaceKey } from "../../lib/workspace-key";
import { PortBadge } from "./PortBadge";
import styles from "./Ports.module.css";

type PortGroupProps = {
  group: WorkspacePortGroup;
};

export function PortGroup(props: PortGroupProps) {
  const { group } = props;

  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);

  const handleSelectWorkspace = useCallback(() => {
    const found = find(
      useProjectStore.getState().projects,
      workspaceKey(group.hostId, group.workspacePath),
    );
    if (found) selectWorkspace(found.project.id, found.index);
  }, [group.workspacePath, group.hostId, selectWorkspace]);

  return (
    <div className={styles.portGroup}>
      {group.branch && (
        <div
          className={styles.portGroupHeader}
          onClick={handleSelectWorkspace}
          style={{ cursor: "pointer" }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleSelectWorkspace();
            }
          }}
        >
          <span className={styles.portGroupBranch}>
            {group.branch}
            {group.isMain && group.projectName && (
              <span className={styles.portGroupProject}>
                {" "}
                · {group.projectName}
              </span>
            )}
          </span>
        </div>
      )}
      {group.ports.map((port) => (
        <PortBadge key={port.port} port={port} />
      ))}
    </div>
  );
}
