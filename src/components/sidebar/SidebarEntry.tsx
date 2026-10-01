import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { useProjectStore, type ProjectInfo } from "../../store/project-store";
import { useAppStore } from "../../store/app-store";
import { isHomePath } from "../../lib/home";
import {
  removeWorktreeWithToast,
  quickMergeWorktreeWithToast,
  hideWorkspaceAndNavigate,
} from "../../store/workspace-actions";
import { ProjectItem, type ProjectItemVariant } from "./ProjectItem";
import { ProjectGroupItem } from "./ProjectGroupItem";
import type { SelectionScope, TopLevelEntry } from "../../utils/sidebar-items";

type SidebarEntryProps = {
  entry: TopLevelEntry;
  onOpenProjectSettings?: (projectId: string) => void;
  /** Starts a project reorder drag. The full sidebar only. */
  onDragStart?: (e: ReactPointerEvent) => void;
  /** True for the frame after a reorder drag, so its pointerup isn't a click. */
  justDraggedRef?: RefObject<boolean>;
  /**
   * Always show the entry's workspaces, whatever its stored collapsed state.
   * The collapsed rail's popover (ADR-195) exists to show them.
   */
  forceExpanded?: boolean;
  /** Fires after a workspace is chosen — the phone drawer closes on it
   *  (ADR-181 ticket 4). */
  onNavigate?: () => void;
};

/**
 * One top-level sidebar entry, a lone project or a linked group (ADR-192),
 * wired to the stores. Shared by the full sidebar and the rail's popover so
 * both render the same rows, menus and actions.
 */
export function SidebarEntry(props: SidebarEntryProps) {
  const {
    entry,
    onOpenProjectSettings,
    onDragStart,
    justDraggedRef,
    forceExpanded = false,
    onNavigate,
  } = props;

  const projects = useProjectStore((s) => s.projects);
  const selectedProjectIndex = useProjectStore((s) => s.selectedProjectIndex);
  const removeProject = useProjectStore((s) => s.removeProject);
  const selectProject = useProjectStore((s) => s.selectProject);
  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);
  const renameWorkspace = useProjectStore((s) => s.renameWorkspace);
  const setWorkspaceHidden = useProjectStore((s) => s.setWorkspaceHidden);
  const createWorktree = useProjectStore((s) => s.createWorktree);
  const collapsedProjectIds = useProjectStore((s) => s.collapsedProjectIds);
  const toggleProjectCollapsed = useProjectStore((s) => s.toggleProjectCollapsed);
  const setProjectExpanded = useProjectStore((s) => s.setProjectExpanded);
  const openOrFocusDiff = useAppStore((s) => s.openOrFocusDiff);
  // While the Tasks view is shown (ADR-198) no project is the current row,
  // same as on Home.
  const homeActive = useAppStore(
    (s) => s.activeSurface !== "workspace" || isHomePath(s.activeWorkspacePath),
  );

  const justDragged = () => justDraggedRef?.current === true;
  const isCollapsed = (key: string) => !forceExpanded && collapsedProjectIds.has(key);
  const toggleCollapsed = (key: string) => {
    if (!forceExpanded && !justDragged()) toggleProjectCollapsed(key);
  };

  const renderProject = (
    project: ProjectInfo,
    variant: ProjectItemVariant,
    projectDragStart?: (e: ReactPointerEvent) => void,
    selectionScope?: SelectionScope,
  ) => {
    const idx = projects.indexOf(project);
    return (
      <ProjectItem
        project={project}
        variant={variant}
        selectionScope={selectionScope}
        isSelected={!homeActive && idx === selectedProjectIndex}
        collapsed={isCollapsed(project.id)}
        onToggleCollapsed={() => toggleCollapsed(project.id)}
        onSelect={() => {
          if (justDragged()) return;
          selectProject(idx);
          setProjectExpanded(project.id);
          const wsIdx = project.selectedWorkspaceIndex;
          selectWorkspace(project.id, wsIdx >= 0 ? wsIdx : 0);
          onNavigate?.();
        }}
        onRemove={() => removeProject(project.id)}
        onSelectWorkspace={(wsIdx) => {
          selectWorkspace(project.id, wsIdx);
          onNavigate?.();
        }}
        onRemoveWorktree={(ws, deleteBranch) =>
          removeWorktreeWithToast(project, ws, deleteBranch)
        }
        onQuickMergeWorktree={(ws) => {
          quickMergeWorktreeWithToast(project, ws);
        }}
        onRenameWorkspace={(ws, newName) =>
          renameWorkspace(project.id, ws.path, newName)
        }
        onHideWorkspace={(ws) => {
          hideWorkspaceAndNavigate(project.id, ws.path);
        }}
        onUnhideWorkspace={(ws) =>
          setWorkspaceHidden(project.id, ws.path, false)
        }
        onCreateWorktree={(projectId, name, branch, options) =>
          createWorktree(projectId, name, branch, options)
        }
        onOpenSettings={() => onOpenProjectSettings?.(project.id)}
        onDragStart={projectDragStart}
        onOpenDiff={(wsIdx) => {
          selectWorkspace(project.id, wsIdx);
          openOrFocusDiff();
        }}
      />
    );
  };

  if (entry.kind === "project") {
    return renderProject(entry.project, "project", onDragStart);
  }

  return (
    <ProjectGroupItem
      entry={entry}
      isSelected={
        !homeActive &&
        entry.sections.some(
          (section) => projects.indexOf(section.project) === selectedProjectIndex,
        )
      }
      collapsed={isCollapsed(entry.key)}
      onToggleCollapsed={() => toggleCollapsed(entry.key)}
      onDragStart={onDragStart}
      renderSection={(section, selectionScope) =>
        renderProject(section.project, "section", undefined, selectionScope)
      }
      onCreateWorktree={(projectId, name, branch, options) =>
        createWorktree(projectId, name, branch, options)
      }
      onUnhideWorkspace={(project, ws) =>
        setWorkspaceHidden(project.id, ws.path, false)
      }
      onOpenSettings={() => onOpenProjectSettings?.(entry.sections[0].project.id)}
      onRemove={() => {
        void (async () => {
          for (const section of entry.sections) {
            await removeProject(section.project.id);
          }
        })();
      }}
    />
  );
}
