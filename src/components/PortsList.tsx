import { useCallback, useRef, useState } from "react";
import { ChevronRight, EthernetPort } from "lucide-react";
import { usePortsData } from "../hooks/usePortsData";
import { useProjectStore } from "../store/project-store";
import { PortGroup } from "./PortGroup";
import styles from "./Sidebar.module.css";

export function PortsList() {
  const { workspacePortGroups, totalPortCount } = usePortsData();
  const [collapsed, setCollapsed] = useState(false);
  const portsHeight = useProjectStore((s) => s.portsHeight);
  const setPortsHeight = useProjectStore((s) => s.setPortsHeight);
  const [isResizing, setIsResizing] = useState(false);
  const startY = useRef(0);
  const startHeight = useRef(0);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      startY.current = e.clientY;
      startHeight.current = portsHeight;

      const onMouseMove = (ev: MouseEvent) => {
        // Dragging up increases height, dragging down decreases
        const delta = startY.current - ev.clientY;
        setPortsHeight(startHeight.current + delta);
      };

      const onMouseUp = () => {
        setIsResizing(false);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [portsHeight, setPortsHeight],
  );

  if (totalPortCount === 0) return null;

  return (
    <div className={styles.portsSection}>
      <div
        className={`${styles.portsResizeHandle} ${isResizing ? styles.portsResizeHandleActive : ""}`}
        onMouseDown={handleResizeStart}
      />
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
        <div className={styles.portGroups} style={{ maxHeight: portsHeight }}>
          {workspacePortGroups.map((group) => (
            <PortGroup key={group.workspacePath} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}
