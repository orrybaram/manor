import { useCallback } from "react";
import { useProjectStore } from "../store/project-store";
import { type WorkspacePortGroup } from "../hooks/usePortsData";
import { PortBadge } from "./PortBadge";
import styles from "./Sidebar.module.css";

type PortGroupProps = {
  group: WorkspacePortGroup;
};

export function PortGroup(props: PortGroupProps) {
  const { group } = props;

  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);

  const handleSelectWorkspace = useCallback(() => {
    const projects = useProjectStore.getState().projects;
    for (const project of projects) {
      const wsIndex = project.workspaces.findIndex(
        (ws) => ws.path === group.workspacePath,
      );
      if (wsIndex >= 0) {
        selectWorkspace(project.id, wsIndex);
        break;
      }
    }
  }, [group.workspacePath, selectWorkspace]);

  return (
    <div className={styles.portGroup}>
      {group.branch && (
        <div
          className={styles.portGroupHeader}
          onClick={handleSelectWorkspace}
          style={{ cursor: "pointer" }}
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
