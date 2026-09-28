import React, { useMemo, type PointerEvent as ReactPointerEvent } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import Link2 from "lucide-react/dist/esm/icons/link-2";
import { useProjectStore } from "../../store/project-store";
import type { GroupSection, TopLevelEntry } from "../../utils/sidebar-items";
import { useWorkspacesAgentStatus } from "../../hooks/useProjectAgentStatus";
import { projectColorStyle, useProjectHeaderRow } from "../../hooks/useProjectHeaderRow";
import { toWorkspaceIndicator } from "../../lib/workspace-indicator";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import { ProjectChevron } from "./ProjectChevron";
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
  const unlinkGroup = useProjectStore((s) => s.unlinkGroup);
  const header = useProjectHeaderRow(collapsed, onToggleCollapsed);

  const allWorkspaces = useMemo(
    () => sections.flatMap((section) => section.project.workspaces),
    [sections],
  );
  const { status, pulse } = useWorkspacesAgentStatus(allWorkspaces);
  const indicator = toWorkspaceIndicator(status, pulse);
  // Shared settings live on the group from ADR-192 ticket 2; until then the
  // first member with a color stands for the group.
  const color = sections.find((s) => s.project.color)?.project.color ?? null;

  return (
    <div
      className={`${styles.project} ${isSelected ? styles.projectSelected : ""}`}
      data-testid="project-group"
      data-group-id={group.id}
      style={projectColorStyle(color)}
    >
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            ref={header.headerRef}
            data-testid="project-group-header"
            data-sidebar-row=""
            tabIndex={-1}
            aria-expanded={!collapsed}
            className={styles.projectHeader}
            onClick={onToggleCollapsed}
            onKeyDown={header.onKeyDown}
            onPointerDown={onDragStart}
            style={{ touchAction: "none" }}
          >
            <ProjectChevron expanded={!collapsed} />
            <span className={`${styles.projectName} ${styles.projectNameRemote}`}>
              {group.name}
            </span>
            <span className={styles.remoteHostIconSlot}>
              <Tooltip label="Linked across hosts" side="right">
                <span className={styles.groupLinkIcon} aria-label="Linked across hosts">
                  <Link2 size={11} aria-hidden />
                </span>
              </Tooltip>
            </span>
            {collapsed && indicator && <WorkspaceIndicatorDot indicator={indicator} />}
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            className={styles.contextMenu}
            onCloseAutoFocus={header.onCloseAutoFocus}
          >
            <ContextMenu.Item
              className={styles.contextMenuItem}
              onSelect={() => void unlinkGroup(group.id)}
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
