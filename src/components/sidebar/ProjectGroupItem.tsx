import React, { useMemo, type PointerEvent as ReactPointerEvent } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import Link2 from "lucide-react/dist/esm/icons/link-2";
import { collapsedFolderIdsOf, useProjectStore } from "../../store/project-store";
import type {
  GroupSection,
  SelectionScope,
  TopLevelEntry,
} from "../../utils/sidebar-items";
import { useGroupAgentStatus } from "../../hooks/useProjectAgentStatus";
import { useHostStore } from "../../store/host-store";
import { groupHostState, isHostOffline, type GroupHostState } from "../../lib/host-status";
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
  /**
   * Renders one member's section — a `ProjectItem` in `variant="section"` —
   * sharing `selectionScope`, the group-wide multi-select (ADR-192 ticket 7).
   */
  renderSection: (
    section: GroupSection,
    selectionScope: SelectionScope,
  ) => React.ReactNode;
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
  const collapsedFolderKeys = useProjectStore((s) => s.collapsedFolderKeys);
  const collapsedProjectIds = useProjectStore((s) => s.collapsedProjectIds);
  const header = useProjectHeaderRow(collapsed, onToggleCollapsed);

  // One selection across every host section, keyed by group id: a range or
  // toggle can cross from one section into the next, and each section reads
  // its own share back out of it.
  const selectionScope = useMemo<SelectionScope>(
    () => ({
      id: group.id,
      sections: sections.map((section) => ({
        project: section.project,
        items: section.items,
        collapsedFolderIds: collapsedFolderIdsOf(section.project, collapsedFolderKeys),
        collapsed: collapsedProjectIds.has(section.project.id),
      })),
    }),
    [group.id, sections, collapsedFolderKeys, collapsedProjectIds],
  );
  // Agents from every host section, each on its own host (ADR-191).
  const members = useMemo(() => sections.map((section) => section.project), [sections]);
  const { status, pulse } = useGroupAgentStatus(members);
  const hosts = useHostStore((s) => s.hosts);
  const hostState = groupHostState(members.map((m) => m.hostId), hosts);
  const linkLabel = groupLinkLabel(hostState);
  const indicator = toWorkspaceIndicator(status, pulse);
  // Shared settings live on the group from ADR-192 ticket 2; until then the
  // first member with a color stands for the group.
  const color = sections.find((s) => s.project.color)?.project.color ?? null;

  return (
    <div
      className={`${styles.project} ${isSelected ? styles.projectSelected : ""}`}
      data-testid="project-group"
      data-group-id={group.id}
      data-host-state={hostState}
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
            <span
              className={`${styles.projectName} ${styles.projectNameRemote} ${
                hostState === "offline" ? styles.groupNameOffline : ""
              }`}
            >
              {group.name}
            </span>
            <span className={styles.remoteHostIconSlot}>
              <Tooltip label={linkLabel} side="right">
                <span
                  className={`${styles.groupLinkIcon} ${
                    hostState === "connected" ? "" : styles.groupLinkIconWarn
                  }`}
                  aria-label={linkLabel}
                  data-testid="project-group-host-state"
                >
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
          {sections.map((section) => {
            // An away host's section keeps its last known workspaces, dimmed;
            // the other sections stay as they are (ADR-192 §5).
            const offline = isHostOffline(section.project.hostId, hosts);
            return (
              <div
                key={section.project.id}
                className={offline ? styles.sectionOffline : undefined}
                data-testid="group-section"
                data-host-offline={offline || undefined}
              >
                {renderSection(section, selectionScope)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The link icon's label, naming the group's host state when not all up. */
function groupLinkLabel(state: GroupHostState): string {
  switch (state) {
    case "offline":
      return "Linked across hosts · Offline";
    case "partially-offline":
      return "Linked across hosts · Partially offline";
    default:
      return "Linked across hosts";
  }
}
