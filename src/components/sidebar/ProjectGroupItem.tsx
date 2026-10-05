import React, { useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import CloudOff from "lucide-react/dist/esm/icons/cloud-off";
import {
  collapsedFolderIdsOf,
  useProjectStore,
  type CreateWorktreeOptions,
  type ProjectInfo,
  type WorkspaceInfo,
} from "../../store/project-store";
import {
  canLinkLocalFolder,
  linkChoices as buildLinkChoices,
  type GroupSection,
  type SelectionScope,
  type TopLevelEntry,
} from "../../utils/sidebar-items";
import { isRemoteHost, memberHostName } from "../../lib/hosts";
import { startingMemberId, type WorkspaceHostChoice } from "../../lib/workspace-host-choices";
import { HostIndicator } from "../hosts/HostIndicator";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog/NewWorkspaceDialog";
import { NewFolderDialog } from "./NewFolderDialog";
import { RemoveProjectDialog } from "./RemoveProjectDialog";
import { useGroupAgentStatus } from "../../hooks/useProjectAgentStatus";
import { useHostStore } from "../../store/host-store";
import { groupHostState, isHostOffline } from "../../lib/host-status";
import { projectColorStyle, useProjectHeaderRow } from "../../hooks/useProjectHeaderRow";
import { toWorkspaceIndicator } from "../../lib/workspace-indicator";
import { ProjectChevron } from "./ProjectChevron";
import { ProjectHeaderActions } from "./ProjectHeaderActions";
import { WorkspaceIndicatorDot } from "./WorkspaceIndicatorDot";
import styles from "./ProjectItem.module.css";
import { Collapse } from "../ui/Collapse/Collapse";
import { CountBadge } from "../ui/CountBadge/CountBadge";

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
  /** `projectId` is the member the New Workspace host picker chose. */
  onCreateWorktree: (
    projectId: string,
    name: string,
    branch: string,
    options: Pick<CreateWorktreeOptions, "baseBranch" | "useExistingBranch" | "agentPrompt">,
  ) => Promise<string | null>;
  onUnhideWorkspace: (project: ProjectInfo, ws: WorkspaceInfo) => void;
  /** Opens the group's settings page. */
  onOpenSettings: () => void;
  /** Removes every member of the group from the sidebar. */
  onRemove: () => void;
};

/**
 * A linked-project group (ADR-192): one sidebar entry for a repo that lives
 * on several hosts. The header collapses, expands and drags like a project;
 * beneath it each member keeps its own section, labeled with its host, with
 * its own workspaces, folders and menus.
 */
export function ProjectGroupItem(props: ProjectGroupItemProps) {
  const {
    entry,
    isSelected,
    collapsed,
    onToggleCollapsed,
    onDragStart,
    renderSection,
    onCreateWorktree,
    onUnhideWorkspace,
    onOpenSettings,
    onRemove,
  } = props;

  const { group, sections } = entry;
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const createWorkspaceFolder = useProjectStore((s) => s.createWorkspaceFolder);
  const linkProjects = useProjectStore((s) => s.linkProjects);
  const linkLocalFolder = useProjectStore((s) => s.linkLocalFolder);
  const allProjects = useProjectStore((s) => s.projects);
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
  const indicator = toWorkspaceIndicator(status, pulse);
  // Linking any member links the group, so the first stands in for it.
  const lead = members[0];
  const linkChoices = useMemo(
    () => (lead ? buildLinkChoices(lead, allProjects) : []),
    [lead, allProjects],
  );
  // "Choose local folder…" links through a remote member, while the group
  // has no local one.
  const localFolderMember = members.find((m) => canLinkLocalFolder(m, allProjects));
  // A folder is only sidebar grouping, so any host can take one — even an
  // away host's section.
  const folderHostChoices = useMemo<WorkspaceHostChoice[]>(
    () =>
      members.map((m) => ({ projectId: m.id, hostId: m.hostId, disabledReason: null })),
    [members],
  );
  // The host New Workspace would start on: the group's last used.
  const folderStartId = lead ? startingMemberId(lead.id, allProjects, hosts) : null;
  const hiddenWorkspaces = members.flatMap((project) =>
    project.workspaces.filter((ws) => ws.hidden).map((ws) => ({ project, ws })),
  );
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
            <span className={styles.projectSwatch} aria-hidden="true" />
            {/* No icon beside the name while expanded (ADR-193 §3): each
                host's heading shows its own state. A group with every host
                away dims its name, and once collapsed — its headings hidden —
                says so with one crossed-out cloud. */}
            <span
              className={`${styles.projectName} ${
                hostState === "offline" ? styles.groupNameOffline : ""
              }`}
            >
              {group.name}
            </span>
            {collapsed && hostState === "offline" && (
              <Tooltip label="Every host of this project is offline" side="right">
                <span className={styles.groupOfflineIcon} data-testid="group-offline-icon">
                  <CloudOff size={11} aria-hidden />
                </span>
              </Tooltip>
            )}
            {collapsed && indicator && <WorkspaceIndicatorDot indicator={indicator} />}
            <ProjectHeaderActions
              onNewWorkspace={() => setNewWorkspaceOpen(true)}
              onNewFolder={() => setNewFolderOpen(true)}
              onOpenSettings={onOpenSettings}
            />
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            className={styles.contextMenu}
            onCloseAutoFocus={header.onCloseAutoFocus}
          >
            <ContextMenu.Item
              className={styles.contextMenuItem}
              onSelect={() => setNewWorkspaceOpen(true)}
            >
              New Workspace
            </ContextMenu.Item>
            <ContextMenu.Item
              className={styles.contextMenuItem}
              onSelect={() => setNewFolderOpen(true)}
            >
              New Folder
            </ContextMenu.Item>
            <ContextMenu.Item className={styles.contextMenuItem} onSelect={onOpenSettings}>
              Project Settings
            </ContextMenu.Item>
            {hiddenWorkspaces.length > 0 && (
              <ContextMenu.Sub>
                <ContextMenu.SubTrigger
                  className={styles.contextMenuItem}
                  style={{ display: "flex", alignItems: "center" }}
                >
                  Hidden
                  <CountBadge count={hiddenWorkspaces.length} style={{ marginLeft: 6 }} />
                  <ChevronRight size={14} style={{ marginLeft: "auto" }} />
                </ContextMenu.SubTrigger>
                <ContextMenu.Portal>
                  <ContextMenu.SubContent
                    className={styles.contextMenu}
                    style={{ maxWidth: 220 }}
                  >
                    {hiddenWorkspaces.map(({ project, ws }) => (
                      <ContextMenu.Item
                        key={`${project.id}:${ws.path}`}
                        className={styles.contextMenuItem}
                        onSelect={() => onUnhideWorkspace(project, ws)}
                      >
                        <div className={styles.workspaceLabel}>
                          <span className={styles.workspaceName}>
                            {ws.name || ws.branch || "main"}
                          </span>
                          <span className={styles.workspaceBranch}>
                            {memberHostName(project.hostId, hosts)}
                          </span>
                        </div>
                      </ContextMenu.Item>
                    ))}
                  </ContextMenu.SubContent>
                </ContextMenu.Portal>
              </ContextMenu.Sub>
            )}
            <ContextMenu.Separator className={styles.contextMenuSeparator} />
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger
                className={styles.contextMenuItem}
                style={{ display: "flex", alignItems: "center" }}
                disabled={linkChoices.length === 0 && !localFolderMember}
              >
                Link with…
                <ChevronRight size={14} style={{ marginLeft: "auto" }} />
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent
                  className={styles.contextMenu}
                  style={{ maxWidth: 260 }}
                >
                  {linkChoices.map((choice) => (
                    <ContextMenu.Item
                      key={choice.key}
                      className={styles.contextMenuItem}
                      style={{ display: "flex", alignItems: "center", gap: 6 }}
                      onSelect={() => lead && void linkProjects(lead.id, choice.targetId)}
                    >
                      {choice.label}
                      {choice.hostIds.filter(isRemoteHost).map((hostId) => (
                        <HostIndicator key={hostId} hostId={hostId} variant="icon" />
                      ))}
                    </ContextMenu.Item>
                  ))}
                  {localFolderMember && (
                    <>
                      {linkChoices.length > 0 && (
                        <ContextMenu.Separator className={styles.contextMenuSeparator} />
                      )}
                      <ContextMenu.Item
                        className={styles.contextMenuItem}
                        onSelect={() => void linkLocalFolder(localFolderMember.id)}
                      >
                        Choose local folder…
                      </ContextMenu.Item>
                    </>
                  )}
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
            <ContextMenu.Separator className={styles.contextMenuSeparator} />
            <ContextMenu.Item
              className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
              onSelect={() => setConfirmRemove(true)}
            >
              Remove Project
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      <Collapse open={!collapsed}>
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
      </Collapse>

      {lead && (
        <NewWorkspaceDialog
          open={newWorkspaceOpen}
          onClose={() => setNewWorkspaceOpen(false)}
          projects={members}
          selectedProjectIndex={0}
          preselectedProjectId={lead.id}
          onSubmit={async (createInId, name, branch, baseBranch, useExistingBranch, _folderId, agentPrompt) => {
            const result = await onCreateWorktree(createInId, name, branch, {
              baseBranch,
              useExistingBranch,
              agentPrompt,
            });
            if (result) setNewWorkspaceOpen(false);
            return !!result;
          }}
        />
      )}

      <NewFolderDialog
        open={newFolderOpen}
        onOpenChange={setNewFolderOpen}
        hostChoices={folderHostChoices}
        initialProjectId={folderStartId}
        onConfirm={(name, projectId) => {
          setNewFolderOpen(false);
          if (projectId) void createWorkspaceFolder(projectId, name);
        }}
      />

      <RemoveProjectDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        projectName={group.name}
        onConfirm={onRemove}
      />
    </div>
  );
}
