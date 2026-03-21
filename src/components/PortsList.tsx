import { useState } from "react";
import { ChevronRight, EthernetPort } from "lucide-react";
import { usePortsData } from "../hooks/usePortsData";
import { PortGroup } from "./PortGroup";
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
          <span className={`${styles.projectChevron} ${!collapsed ? styles.projectChevronOpen : ""}`}>
            <ChevronRight size={12} />
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
