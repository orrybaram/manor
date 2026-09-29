import { useCallback } from "react";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import EthernetPort from "lucide-react/dist/esm/icons/ethernet-port";
import { usePortsData } from "./usePortsData";
import { useProjectStore, MIN_PORTS_HEIGHT, MAX_PORTS_HEIGHT } from "../../store/project-store";
import { useCollapsibleResize } from "../../hooks/useCollapsibleResize";
import { PortGroup } from "./PortGroup";
import styles from "./Ports.module.css";

export function PortsList() {
  const { workspacePortGroups, totalPortCount } = usePortsData();
  // Persisted, so a folded Ports pane stays folded across restarts.
  const collapsed = useProjectStore((s) => s.portsCollapsed);
  const setPortsCollapsed = useProjectStore((s) => s.setPortsCollapsed);
  const setCollapsed = useCallback(
    (next: boolean) => {
      if (useProjectStore.getState().portsCollapsed !== next) setPortsCollapsed(next);
    },
    [setPortsCollapsed],
  );
  const portsHeight = useProjectStore((s) => s.portsHeight);
  const setPortsHeight = useProjectStore((s) => s.setPortsHeight);
  const { isResizing, showBody, bodyHeight, onResizeStart } = useCollapsibleResize({
    height: portsHeight,
    setHeight: setPortsHeight,
    collapsed,
    setCollapsed,
    min: MIN_PORTS_HEIGHT,
    max: MAX_PORTS_HEIGHT,
  });

  if (totalPortCount === 0) return null;

  return (
    <div className={styles.portsSection}>
      <div
        className={`${styles.portsResizeHandle} ${isResizing ? styles.portsResizeHandleActive : ""}`}
        onMouseDown={onResizeStart}
      />
      <div
        className={styles.sectionHeader}
        style={{ cursor: "pointer" }}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand ports" : "Collapse ports"}
        onClick={() => setCollapsed(!collapsed)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setCollapsed(!collapsed);
          }
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span
            className={`${styles.projectChevron} ${!collapsed ? styles.projectChevronOpen : ""}`}
          >
            <ChevronRight size={12} />
          </span>
          <EthernetPort size={12} />
          Ports
          <span className={styles.portCount}>{totalPortCount}</span>
        </span>
      </div>
      {showBody && (
        <div className={styles.portGroups} style={{ height: bodyHeight }}>
          {workspacePortGroups.map((group) => (
            <PortGroup key={group.workspacePath} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}
