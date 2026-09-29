import { useCallback, useMemo } from "react";
import { useProjectStore } from "../../../store/project-store";
import { useAppStore } from "../../../store/app-store";
import { useAgentStore } from "../../../store/agent-store";
import { useHostStore } from "../../../store/host-store";
import { usePortsStore, acquirePortsScanner } from "../../../store/ports-store";
import { useActiveSnoozes } from "../../../store/snooze-store";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { memberHostName } from "../../../lib/hosts";
import {
  projectTiles,
  type ProjectTile as ProjectTileData,
  type WorkspaceTileState,
} from "../../../lib/home-dashboard-studio";
import { ProjectTile } from "./ProjectTile";
import { useSelectWorkspace } from "./useSelectWorkspace";
import styles from "./ProjectTiles.module.css";

/** Most urgent first: the workspace a tile click opens. */
const URGENCY: WorkspaceTileState[] = ["needs-you", "running", "pr-ready", "pr-open", "idle"];

type ProjectTilesProps = {
  now: number;
};

/**
 * The project tiles (ADR-198 §1.8): one per sidebar entry, full width. A tile
 * click opens its most urgent workspace; a block opens that workspace.
 */
export function ProjectTiles(props: ProjectTilesProps) {
  const { now } = props;

  const projects = useProjectStore((s) => s.projects);
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);
  const agents = useAgentStore((s) => s.agents);
  const unseenRespondedAgentIds = useAgentStore((s) => s.unseenRespondedAgentIds);
  const hosts = useHostStore((s) => s.hosts);
  const ports = usePortsStore((s) => s.ports);
  const snoozed = useActiveSnoozes();
  const openWorkspace = useSelectWorkspace();

  // The port scanner is shared with the sidebar's Ports list.
  useMountEffect(() => acquirePortsScanner());

  const tiles = useMemo(
    () =>
      projectTiles(projects, {
        projects,
        agents,
        paneAgentStatus,
        unseenRespondedAgentIds,
        snoozed,
        hosts,
        hostName: (hostId: string) => memberHostName(hostId, hosts),
        ports,
        now,
      }),
    [projects, agents, paneAgentStatus, unseenRespondedAgentIds, snoozed, hosts, ports, now],
  );

  const openTileWorkspace = useCallback(
    (workspace: ProjectTileData["workspaces"][number]) => {
      const project = projects.find((p) => p.id === workspace.projectId);
      const ws = project?.workspaces.find((w) => w.path === workspace.path);
      if (project && ws) openWorkspace(project, ws);
    },
    [projects, openWorkspace],
  );

  const openTile = useCallback(
    (tile: ProjectTileData) => {
      const target = [...tile.workspaces].sort(
        (a, b) => URGENCY.indexOf(a.state) - URGENCY.indexOf(b.state),
      )[0];
      if (target) openTileWorkspace(target);
    },
    [openTileWorkspace],
  );

  if (tiles.length === 0) return null;

  return (
    <div className={styles.projects}>
      {tiles.map((tile) => (
        <ProjectTile key={tile.key} tile={tile} onOpen={openTile} onOpenWorkspace={openTileWorkspace} />
      ))}
    </div>
  );
}
