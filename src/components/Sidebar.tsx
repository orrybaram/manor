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
  const selectWorktree = useProjectStore((s) => s.selectWorktree);
  const sidebarWidth = useProjectStore((s) => s.sidebarWidth);
  const setSidebarWidth = useProjectStore((s) => s.setSidebarWidth);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

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
              onSelectWorktree={(wtIdx) =>
                selectWorktree(project.id, wtIdx)
              }
            />
          ))}
        </div>
      </div>

      {/* Show selected worktree path as CWD hint */}
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
  onSelectWorktree,
}: {
  project: ProjectInfo;
  isSelected: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onSelectWorktree: (index: number) => void;
}) {
  const [expanded, setExpanded] = useState(isSelected);
  const addTab = useAppStore((s) => s.addTab);

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
        <div className="sidebar-worktrees">
          {project.worktrees.map((wt, idx) => (
            <div
              key={wt.path}
              className={`sidebar-worktree ${
                idx === project.selectedWorktreeIndex ? "active" : ""
              }`}
              onClick={() => {
                onSelectWorktree(idx);
                // Open a new tab in this worktree's directory
                addTab();
              }}
            >
              <span className="sidebar-worktree-branch">{wt.branch || "main"}</span>
              {wt.isMain && <span className="sidebar-worktree-badge">main</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
