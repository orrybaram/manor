import { useEffect, useCallback, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useProjectStore, type ProjectInfo } from "../store/project-store";
import { useAppStore } from "../store/app-store";

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

  useEffect(() => {
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
  }, [loadProjects, setActiveWorkspace]);

  const handleAddProject = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      const path = typeof selected === "string" ? selected : selected;
      const name = path.split("/").pop() || "Untitled";
      await addProject(name, path);
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
      className="sidebar"
      style={{ width: sidebarWidth }}
    >
      <div className="sidebar-content">
        <div className="sidebar-section">
          <div className="sidebar-section-header">
            <span>Projects</span>
            <button className="sidebar-action" onClick={handleAddProject}>
              +
            </button>
          </div>
          {projects.length === 0 && (
            <div className="sidebar-empty">
              No projects yet.
              <br />
              <button className="sidebar-link" onClick={handleAddProject}>
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

      {selectedProject && (
        <div className="sidebar-footer">
          <span className="sidebar-cwd" title={selectedProject.path}>
            {selectedProject.path.split("/").slice(-2).join("/")}
          </span>
        </div>
      )}

      <div
        className={`sidebar-resize-handle ${isResizing ? "active" : ""}`}
        onMouseDown={handleResizeStart}
      />
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
    <div className={`sidebar-project ${isSelected ? "selected" : ""}`}>
      <div
        className="sidebar-project-header"
        onClick={() => {
          onSelect();
          setExpanded(!expanded);
        }}
      >
        <span className="sidebar-project-chevron">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="sidebar-project-name">{project.name}</span>
        <button
          className="sidebar-project-remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          ×
        </button>
      </div>
      {expanded && (
        <div className="sidebar-workspaces">
          {project.workspaces.map((ws, idx) => (
            <div
              key={ws.path}
              className={`sidebar-workspace ${
                idx === project.selectedWorkspaceIndex ? "active" : ""
              }`}
              onClick={() => onSelectWorkspace(idx)}
            >
              <span className="sidebar-workspace-branch">{ws.branch || "main"}</span>
              {ws.isMain && <span className="sidebar-workspace-badge">main</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
