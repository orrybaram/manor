import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import { projectColorStyle } from "../../../hooks/useProjectHeaderRow";
import type { ProjectTile as ProjectTileData } from "../../../lib/home-dashboard-studio";
import { Button } from "../../ui/Button/Button";
import { useDashboardAnimate } from "./useDashboardAnimate";
import { WorkspacePopover } from "./WorkspacePopover";
import { WORKSPACE_STATE_LABEL } from "./workspace-state";
import styles from "./ProjectTiles.module.css";

const HOST_COLOR = {
  online: "var(--green)",
  partial: "var(--yellow)",
  offline: "var(--red)",
} as const;

const HOST_LABEL = {
  online: "",
  partial: " · partly offline",
  offline: " · offline",
} as const;

type ProjectTileProps = {
  tile: ProjectTileData;
  /** Open the tile's most urgent workspace. */
  onOpen: (tile: ProjectTileData) => void;
  /** Open one of the tile's workspaces. */
  onOpenWorkspace: (workspace: ProjectTileData["workspaces"][number]) => void;
};

/**
 * One project's tile (ADR-198 §1.8): name and host status, a block per
 * workspace coloured by state, and a diff / port footer. The tile is a
 * `role="button"` div because its blocks are real buttons and can't nest.
 */
export function ProjectTile(props: ProjectTileProps) {
  const { tile, onOpen, onOpenWorkspace } = props;
  const count = tile.workspaces.length;
  const animate = useDashboardAnimate();

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(tile);
    }
  };

  return (
    <div
      className={styles.tile}
      style={projectColorStyle(tile.color)}
      role="button"
      tabIndex={0}
      aria-label={`Open ${tile.name}`}
      onClick={() => onOpen(tile)}
      onKeyDown={onKeyDown}
    >
      <div className={styles.head}>
        <span className={styles.swatch} />
        <b className={styles.name}>{tile.name}</b>
        <span
          className={styles.host}
          style={{ "--c": HOST_COLOR[tile.host.state] } as CSSProperties}
        >
          <i />
          {tile.host.status ??
            `${tile.host.label}${HOST_LABEL[tile.host.state]}`}
        </span>
      </div>

      <div ref={animate} className={styles.wsbar}>
        {tile.workspaces.map((ws) => (
          <WorkspacePopover
            key={ws.key}
            projectId={ws.projectId}
            path={ws.path}
            state={ws.state}
          >
            <Button
              variant="ghost"
              className={styles.block}
              data-state={ws.state}
              aria-label={`${ws.name}, ${WORKSPACE_STATE_LABEL[ws.state]}`}
              onClick={(e: MouseEvent) => {
                e.stopPropagation();
                onOpenWorkspace(ws);
              }}
            />
          </WorkspacePopover>
        ))}
      </div>

      <div className={styles.foot}>
        <span>
          {count} {count === 1 ? "workspace" : "workspaces"}
          {(tile.diff.added > 0 || tile.diff.removed > 0) && (
            <>
              {" · "}
              <span className={styles.added}>+{tile.diff.added}</span>{" "}
              <span className={styles.removed}>−{tile.diff.removed}</span>
            </>
          )}
        </span>
        {tile.port && <span className={styles.port}>:{tile.port.port}</span>}
      </div>
    </div>
  );
}
