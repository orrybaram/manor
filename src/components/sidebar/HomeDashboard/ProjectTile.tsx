import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import { projectColorStyle } from "../../../hooks/useProjectHeaderRow";
import type { ProjectTile as ProjectTileData, WorkspaceTileState } from "../../../lib/home-dashboard-studio";
import { Button } from "../../ui/Button/Button";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import styles from "./ProjectTiles.module.css";

const STATE_LABEL: Record<WorkspaceTileState, string> = {
  "needs-you": "Needs you",
  running: "Agent running",
  "pr-ready": "PR ready",
  "pr-open": "PR open",
  idle: "Idle",
};

const HOST_COLOR = {
  online: "var(--green)",
  partial: "var(--yellow)",
  offline: "var(--red)",
} as const;

const HOST_LABEL = { online: "", partial: " · partly offline", offline: " · offline" } as const;

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
        <span className={styles.host} style={{ "--c": HOST_COLOR[tile.host.state] } as CSSProperties}>
          <i />
          {tile.host.status ?? `${tile.host.label}${HOST_LABEL[tile.host.state]}`}
        </span>
      </div>

      <div className={styles.wsbar}>
        {tile.workspaces.map((ws) => (
          <Tooltip key={ws.key} label={`${ws.name} · ${STATE_LABEL[ws.state]}`}>
            <Button
              variant="ghost"
              className={styles.block}
              data-state={ws.state}
              aria-label={`${ws.name}, ${STATE_LABEL[ws.state]}`}
              onClick={(e: MouseEvent) => {
                e.stopPropagation();
                onOpenWorkspace(ws);
              }}
            />
          </Tooltip>
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
