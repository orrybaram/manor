import { useCallback, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  EthernetPort,
} from "lucide-react";
import { useProjectStore } from "../store/project-store";
import { useAppStore } from "../store/app-store";
import { usePortsData, type WorkspacePortGroup } from "../hooks/usePortsData";
import styles from "./Sidebar.module.css";

export function PortsList() {
  const { workspacePortGroups, totalPortCount } = usePortsData();
  const [collapsed, setCollapsed] = useState(false);

  if (totalPortCount === 0) return null;

  return (
    <div className={styles.portsSection}>
      <div
        className={styles.sectionHeader}
        style={{ cursor: "pointer" }}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span className={styles.projectChevron}>
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </span>
          <EthernetPort size={12} />
          Ports
          <span className={styles.portCount}>{totalPortCount}</span>
        </span>
      </div>
      {!collapsed && (
        <div className={styles.portGroups}>
          {workspacePortGroups.map((group) => (
            <PortGroup key={group.workspacePath} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}

function PortGroup({ group }: { group: WorkspacePortGroup }) {
  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace);

  const handleSelectWorkspace = useCallback(() => {
    const projects = useProjectStore.getState().projects;
    for (const project of projects) {
      const wsIndex = project.workspaces.findIndex(
        (ws) => ws.path === group.workspacePath,
      );
      if (wsIndex >= 0) {
        selectWorkspace(project.id, wsIndex);
        setActiveWorkspace(group.workspacePath);
        break;
      }
    }
  }, [group.workspacePath, selectWorkspace, setActiveWorkspace]);

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

function PortBadge({ port }: { port: import("../electron.d.ts").ActivePort }) {
  const handleOpen = useCallback(() => {
    window.electronAPI.openExternal(`http://localhost:${port.port}`);
  }, [port.port]);

  return (
    <div
      className={styles.portBadge}
      title={`Open localhost:${port.port}`}
      onClick={handleOpen}
      style={{ cursor: "pointer" }}
    >
      <span className={styles.portNumber}>{port.port}</span>
      <span className={styles.portProcess}>{port.processName}</span>
      <ExternalLink size={12} className={styles.portOpen} />
    </div>
  );
}
