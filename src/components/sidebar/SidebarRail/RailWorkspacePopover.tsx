import { useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Button } from "../../ui/Button/Button";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import {
  useProjectStore,
  type ProjectInfo,
  type WorkspaceInfo,
} from "../../../store/project-store";
import { useAppStore } from "../../../store/app-store";
import { useHostStore } from "../../../store/host-store";
import { useWorkspaceAgentStatus } from "../../../hooks/useWorkspaceAgentStatus";
import { projectColorStyle } from "../../../hooks/useProjectHeaderRow";
import { workspaceKey } from "../../../lib/workspace-key";
import { normalizeHostId } from "../../../lib/host-id";
import { isRemoteHost } from "../../../lib/hosts";
import { isHostOffline } from "../../../lib/host-status";
import { toWorkspaceIndicator } from "../../../lib/workspace-indicator";
import {
  railWorkspaceRows,
  remoteTargetForProject,
  workspaceDisplayName,
} from "../../../lib/sidebar-rail";
import type { TopLevelEntry } from "../../../utils/sidebar-items";
import { SectionHostLabel } from "../ProjectItem";
import { WorkspaceIndicatorDot } from "../WorkspaceIndicatorDot";
import styles from "./SidebarRail.module.css";

const ROW_SELECTOR = "[data-rail-popover-row]";

type RailWorkspacePopoverProps = {
  entry: TopLevelEntry;
  name: string;
  color: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The tile. Rendered as the popover's trigger, under a name tooltip. */
  children: ReactNode;
};

/**
 * The rail tile's popover (ADR-195 §2): the entry's workspaces in sidebar
 * tree order, grouped under host headings for a linked group. Picking one
 * switches to it the way the full sidebar does.
 */
export function RailWorkspacePopover(props: RailWorkspacePopoverProps) {
  const { entry, name, color, open, onOpenChange, children } = props;

  const rows = useMemo(() => railWorkspaceRows(entry), [entry]);
  const projects = useProjectStore((s) => s.projects);
  const selectProject = useProjectStore((s) => s.selectProject);
  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);
  // Set when a row was picked, so closing hands the keyboard to the pane
  // rather than back to the tile.
  const pickedRef = useRef(false);

  const pick = (project: ProjectInfo, ws: WorkspaceInfo) => {
    selectProject(projects.indexOf(project));
    selectWorkspace(project.id, project.workspaces.indexOf(ws));
    pickedRef.current = true;
    onOpenChange(false);
  };

  const projectForHost = (hostId: string | null): ProjectInfo | undefined =>
    entry.kind === "group"
      ? entry.sections.find((s) => (s.project.hostId ?? null) === hostId)?.project
      : entry.project;

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const list = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>(ROW_SELECTOR),
    );
    if (list.length === 0) return;
    e.preventDefault();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "ArrowDown"
        ? Math.min(index + 1, list.length - 1)
        : Math.max(index - 1, 0);
    list[next]?.focus();
  };

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Tooltip label={name} side="right">
        <Popover.Trigger asChild>{children}</Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content
          className={styles.popover}
          data-testid="rail-workspace-popover"
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          style={projectColorStyle(color)}
          onKeyDown={handleKeyDown}
          // Land on the active workspace, else the first row.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            const content = e.currentTarget as HTMLElement | null;
            const list = Array.from(
              content?.querySelectorAll<HTMLElement>(ROW_SELECTOR) ?? [],
            );
            (
              list.find((row) => row.getAttribute("aria-current") === "true") ??
              list[0]
            )?.focus();
          }}
          onCloseAutoFocus={(e) => {
            if (!pickedRef.current) return;
            pickedRef.current = false;
            e.preventDefault();
            useAppStore.getState().refocusActivePane();
          }}
        >
          <div className={styles.popoverHeading}>{name}</div>
          {rows.length === 0 && (
            <div className={styles.popoverEmpty}>No workspaces</div>
          )}
          {rows.map((row) => {
            if (row.kind === "host") {
              const project = projectForHost(row.hostId);
              if (!project) return null;
              return <RailHostRow key={`host:${row.hostId}`} project={project} />;
            }
            if (row.kind === "folder") {
              return (
                <div
                  key={`folder:${row.key}`}
                  className={styles.folderRow}
                  style={{ paddingLeft: 6 + row.depth * 10 }}
                >
                  {row.name}
                </div>
              );
            }
            return (
              <RailWorkspaceRow
                key={`${row.project.id}:${row.ws.path}`}
                project={row.project}
                ws={row.ws}
                onPick={() => pick(row.project, row.ws)}
              />
            );
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

type RailHostRowProps = {
  project: ProjectInfo;
};

/** A linked group's host heading, as in the full sidebar (ADR-193 §3). */
function RailHostRow(props: RailHostRowProps) {
  const { project } = props;

  const remoteTarget = useHostStore((state) => remoteTargetForProject(project, state));
  const hosts = useHostStore((s) => s.hosts);

  return (
    <div className={styles.hostRow} data-testid="rail-host-heading">
      <SectionHostLabel
        hostId={project.hostId}
        path={project.path}
        label={isRemoteHost(project.hostId) ? remoteTarget ?? project.hostId : "This machine"}
        offline={isHostOffline(project.hostId, hosts)}
        collapsedCount={null}
      />
    </div>
  );
}

type RailWorkspaceRowProps = {
  project: ProjectInfo;
  ws: WorkspaceInfo;
  onPick: () => void;
};

function RailWorkspaceRow(props: RailWorkspaceRowProps) {
  const { project, ws, onPick } = props;

  const remoteTarget = useHostStore((state) => remoteTargetForProject(project, state));
  const { status, pulse } = useWorkspaceAgentStatus(workspaceKey(project.hostId, ws.path));
  const indicator = toWorkspaceIndicator(status, pulse);
  // A path can be on two hosts (ADR-191): only the active host's copy is active.
  const isActive = useAppStore(
    (s) =>
      s.activeWorkspaceHostId === normalizeHostId(project.hostId) &&
      s.activeWorkspacePath === ws.path,
  );
  const displayName = workspaceDisplayName(ws, remoteTarget);

  return (
    <Button
      variant="ghost"
      size="sm"
      className={`${styles.row} ${isActive ? styles.rowActive : ""}`}
      data-rail-popover-row=""
      data-testid="rail-workspace-row"
      aria-current={isActive ? "true" : undefined}
      title={displayName}
      onClick={onPick}
    >
      <span className={styles.rowName}>{displayName}</span>
      {indicator && <WorkspaceIndicatorDot indicator={indicator} />}
    </Button>
  );
}
