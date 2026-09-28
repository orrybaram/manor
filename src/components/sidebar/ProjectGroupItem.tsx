import React, { useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Link2 from "lucide-react/dist/esm/icons/link-2";
import { useProjectStore, type ProjectInfo } from "../../store/project-store";
import type { GroupSection, TopLevelEntry } from "../../utils/sidebar-items";
import { useWorkspacesAgentStatus } from "../../hooks/useProjectAgentStatus";
import { toWorkspaceIndicator } from "../../lib/workspace-indicator";
import { handleSidebarRowKeyDown } from "../../lib/sidebar-row";
import { openContextMenuFromKeyboard } from "../../lib/keyboard-context-menu";
import { WorkspaceIndicatorDot } from "./WorkspaceIndicatorDot";
import styles from "./ProjectItem.module.css";

type GroupEntry = Extract<TopLevelEntry, { kind: "group" }>;

type ProjectGroupItemProps = {
  entry: GroupEntry;
  /** True when one of the group's members is the selected project. */
  isSelected: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onDragStart?: (e: ReactPointerEvent) => void;
  /** Renders one member's section — a `ProjectItem` in `variant="section"`. */
  renderSection: (section: GroupSection) => React.ReactNode;
};

/**
 * A linked-project group (ADR-192): one sidebar entry for a repo that lives
 * on several hosts. The header collapses, expands and drags like a project;
 * beneath it each member keeps its own section, labeled with its host, with
 * its own workspaces, folders and menus.
 */
export function ProjectGroupItem(props: ProjectGroupItemProps) {
  const { entry, isSelected, collapsed, onToggleCollapsed, onDragStart, renderSection } =
    props;
  const { group, sections } = entry;
  const unlinkProject = useProjectStore((s) => s.unlinkProject);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const menuOpenedByKeyboard = useRef(false);

  const allWorkspaces = useMemo(
    () => sections.flatMap((section) => section.project.workspaces),
    [sections],
  );
  const { status, pulse } = useWorkspacesAgentStatus(allWorkspaces);
  const indicator = toWorkspaceIndicator(status, pulse);
  // Shared settings live on the group from ADR-192 ticket 2; until then the
  // first member's color stands for the group.
  const color = sections.find((s) => s.project.color)?.project.color ?? null;

  const ungroup = async (members: ProjectInfo[]) => {
    // The last member leaves with the one before it: a group of one dissolves.
    for (const member of members.slice(0, -1)) await unlinkProject(member.id);
  };

  return (
    <div
      className={`${styles.project} ${isSelected ? styles.projectSelected : ""}`}
      data-testid="project-group"
      data-group-id={group.id}
      style={
        color
          ? ({ "--project-color": `var(--${color})` } as React.CSSProperties)
          : undefined
      }
    >
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            ref={headerRef}
            data-testid="project-group-header"
            data-sidebar-row=""
            tabIndex={-1}
            aria-expanded={!collapsed}
            className={styles.projectHeader}
            onClick={onToggleCollapsed}
            onKeyDown={(e) =>
              handleSidebarRowKeyDown(e, {
                activate: onToggleCollapsed,
                setExpanded: (next) => {
                  if (next === collapsed) onToggleCollapsed();
                },
                openMenu: (row) => {
                  menuOpenedByKeyboard.current = true;
                  openContextMenuFromKeyboard(row);
                },
              })
            }
            onPointerDown={onDragStart}
            style={{ touchAction: "none" }}
          >
            <span
              className={`${styles.projectChevron} ${collapsed ? "" : styles.projectChevronOpen}`}
            >
              <ChevronRight size={12} />
            </span>
            <span className={`${styles.projectName} ${styles.projectNameRemote}`}>
              {group.name}
            </span>
            <span className={styles.remoteHostIconSlot} title="Linked across hosts">
              <Link2 size={11} aria-label="Linked across hosts" />
            </span>
            {collapsed && indicator && <WorkspaceIndicatorDot indicator={indicator} />}
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            className={styles.contextMenu}
            onCloseAutoFocus={(e) => {
              if (menuOpenedByKeyboard.current) {
                e.preventDefault();
                headerRef.current?.focus();
              }
              menuOpenedByKeyboard.current = false;
            }}
          >
            <ContextMenu.Item
              className={styles.contextMenuItem}
              onSelect={() => void ungroup(sections.map((s) => s.project))}
            >
              Unlink All
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {!collapsed && (
        <div className={styles.groupSections}>
          {sections.map((section) => (
            <React.Fragment key={section.project.id}>
              {renderSection(section)}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
