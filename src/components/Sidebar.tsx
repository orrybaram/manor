import { useEffect, useCallback, useRef, useState } from "react";
import { useProjectStore, type ProjectInfo } from "../store/project-store";
import { useAppStore } from "../store/app-store";
import { usePortsData, type WorkspacePortGroup } from "../hooks/usePortsData";
import styles from "./Sidebar.module.css";

export function Sidebar() {
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectIndex = useProjectStore((s) => s.selectedProjectIndex);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const addProject = useProjectStore((s) => s.addProject);
  const removeProject = useProjectStore((s) => s.removeProject);
  const selectProject = useProjectStore((s) => s.selectProject);
  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);
  const sidebarWidth = useProjectStore((s) => s.sidebarWidth);
  const setSidebarWidth = useProjectStore((s) => s.setSidebarWidth);
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace);
  const loadPersistedLayout = useAppStore((s) => s.loadPersistedLayout);

  useEffect(() => {
    // Load persisted layout FIRST so setActiveWorkspace can restore old pane IDs
    loadPersistedLayout().then(() => {
      loadProjects().then(() => {
        const { projects, selectedProjectIndex } = useProjectStore.getState();
        const project = projects[selectedProjectIndex];
        if (project) {
          const ws =
            project.workspaces[project.selectedWorkspaceIndex] ??
            project.workspaces[0];
          if (ws) setActiveWorkspace(ws.path);
        }
      });
    });
  }, [loadProjects, loadPersistedLayout, setActiveWorkspace]);

  const handleAddProject = useCallback(async () => {
    const selected = await window.electronAPI.openDirectory();
    if (selected) {
      const name = selected.split("/").pop() || "Untitled";
      await addProject(name, selected);
    }
  }, [addProject]);

  // Resizable sidebar
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);

      const onMouseMove = (ev: MouseEvent) => {
        const newWidth = Math.max(160, Math.min(400, ev.clientX));
        setSidebarWidth(newWidth);
      };

      const onMouseUp = () => {
        setIsResizing(false);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [setSidebarWidth]
  );

  const selectedProject = projects[selectedProjectIndex] as
    | ProjectInfo
    | undefined;

  return (
    <div
      ref={sidebarRef}
      className={styles.sidebar}
      style={{ width: sidebarWidth }}
    >
      <div className={styles.titlebar} />
      <div className={styles.content}>
        <div>
          <div className={styles.sectionHeader}>
            <span>Projects</span>
            <button className={styles.action} onClick={handleAddProject}>
              +
            </button>
          </div>
          {projects.length === 0 && (
            <div className={styles.empty}>
              No projects yet.
              <br />
              <button className={styles.link} onClick={handleAddProject}>
                Open a folder
              </button>
            </div>
          )}
          {projects.map((project, idx) => (
            <ProjectItem
              key={project.id}
              project={project}
              isSelected={idx === selectedProjectIndex}
              onSelect={() => selectProject(idx)}
              onRemove={() => removeProject(project.id)}
              onSelectWorkspace={(wsIdx) => {
                selectWorkspace(project.id, wsIdx);
                const ws = project.workspaces[wsIdx];
                if (ws) setActiveWorkspace(ws.path);
              }}
            />
          ))}
        </div>
      </div>
      <PortsList />

      {selectedProject && (
        <div className={styles.footer}>
          <span className={styles.cwd} title={selectedProject.path}>
            {selectedProject.path.split("/").slice(-2).join("/")}
          </span>
        </div>
      )}

      <div
        className={`${styles.resizeHandle} ${isResizing ? styles.resizeHandleActive : ""}`}
        onMouseDown={handleResizeStart}
      />
    </div>
  );
}

function PortsList() {
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
        <span>
          <span
            className={styles.projectChevron}
            style={{ marginRight: 4 }}
          >
            {collapsed ? "▸" : "▾"}
          </span>
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
  return (
    <div className={styles.portGroup}>
      {group.branch && (
        <div className={styles.portGroupHeader}>
          <span className={styles.portGroupBranch}>{group.branch}</span>
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
    window.open(`http://localhost:${port.port}`, "_blank");
  }, [port.port]);

  return (
    <div className={styles.portBadge} title={`${port.processName} (PID ${port.pid})`}>
      <span className={styles.portNumber}>{port.port}</span>
      <span className={styles.portProcess}>{port.processName}</span>
      <button
        className={styles.portOpen}
        onClick={handleOpen}
        title={`Open localhost:${port.port}`}
      >
        ↗
      </button>
    </div>
  );
}

function ProjectItem({
  project,
  isSelected,
  onSelect,
  onRemove,
  onSelectWorkspace,
}: {
  project: ProjectInfo;
  isSelected: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onSelectWorkspace: (index: number) => void;
}) {
  const [expanded, setExpanded] = useState(isSelected);

  return (
    <div className={`${styles.project} ${isSelected ? styles.projectSelected : ""}`}>
      <div
        className={styles.projectHeader}
        onClick={() => {
          onSelect();
          setExpanded(!expanded);
        }}
      >
        <span className={styles.projectChevron}>
          {expanded ? "▾" : "▸"}
        </span>
        <span className={styles.projectName}>{project.name}</span>
        <button
          className={styles.projectRemove}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          ×
        </button>
      </div>
      {expanded && (
        <div className={styles.workspaces}>
          {project.workspaces.map((ws, idx) => (
            <div
              key={ws.path}
              className={`${styles.workspace} ${
                idx === project.selectedWorkspaceIndex ? styles.workspaceActive : ""
              }`}
              onClick={() => onSelectWorkspace(idx)}
            >
              <span className={styles.workspaceBranch}>{ws.branch || "main"}</span>
              {ws.isMain && <span className={styles.workspaceBadge}>main</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
