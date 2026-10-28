import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useProjectStore, type ProjectInfo } from "../../store/project-store";
import { useAppStore } from "../../store/app-store";
import { useHostStore } from "../../store/host-store";
import {
  rememberContextMenuPoint,
  useMoveToWorkspaceStore,
  type MoveToWorkspaceRequest,
} from "../../store/move-to-workspace-store";
import { moveToWorkspaceAndFollow } from "../../store/workspace-actions";
import { matchesMoveQuery, workspaceMoveTargets } from "../../lib/workspace-move-targets";
import { remoteTargetForProject, workspaceDisplayName } from "../../lib/sidebar-rail";
import { toWorkspaceIndicator } from "../../lib/workspace-indicator";
import { useServerHostName } from "../../bridge/server-set";
import { useWorkspaceAgentStatus } from "../../hooks/useWorkspaceAgentStatus";
import { useMountEffect } from "../../hooks/useMountEffect";
import { WorkspaceIndicatorDot } from "../sidebar/WorkspaceIndicatorDot";
import type { WorkspaceKey } from "../../lib/workspace-key";
import styles from "./MoveToWorkspacePicker.module.css";

/**
 * The "Move to Workspace…" picker: a popover where the pane or tab was
 * right-clicked, listing the project's other workspaces on that host
 * (`workspaceMoveTargets`). Typing filters, the first match is selected,
 * arrows move the selection, Enter or a click moves, Esc closes.
 *
 * Mounted once by the app; a context menu item opens it through
 * `useMoveToWorkspaceStore`. It also records every right-click's point, since
 * the item is only told it was selected.
 */
export function MoveToWorkspacePicker() {
  const request = useMoveToWorkspaceStore((s) => s.request);
  const close = useMoveToWorkspaceStore((s) => s.close);

  useMountEffect(() => {
    window.addEventListener("contextmenu", rememberContextMenuPoint, true);
    return () => window.removeEventListener("contextmenu", rememberContextMenuPoint, true);
  });

  return (
    <Popover.Root open={request !== null} onOpenChange={(open) => !open && close()}>
      {request && (
        // Keyed by the request, so each opening starts with an empty search.
        <PickerContent key={requestKey(request)} request={request} onClose={close} />
      )}
    </Popover.Root>
  );
}

function requestKey(request: MoveToWorkspaceRequest): string {
  const id = "paneId" in request.target ? request.target.paneId : request.target.tabId;
  return `${request.from}|${id}|${request.point.x},${request.point.y}`;
}

function PickerContent({
  request,
  onClose,
}: {
  request: MoveToWorkspaceRequest;
  onClose: () => void;
}) {
  const { from, target, point } = request;
  const projects = useProjectStore((s) => s.projects);
  const targets = useMemo(() => workspaceMoveTargets(projects, from), [projects, from]);
  const project = targets[0]?.project ?? null;
  const remoteTarget = useRemoteTarget(project);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The context menu that opened this hands focus back to its trigger a
  // task after it closes (Radix's FocusScope); take it back after that.
  useMountEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  });

  const rows = useMemo(
    () =>
      targets
        .map((t) => ({ ...t, label: workspaceDisplayName(t.workspace, remoteTarget) }))
        .filter((t) => matchesMoveQuery(t.label, t.workspace.branch, query)),
    [targets, remoteTarget, query],
  );
  const current = Math.min(selected, Math.max(rows.length - 1, 0));

  // A zero-size box at the right-click: the popover's corner sits there.
  const anchor = useRef({
    getBoundingClientRect: () => DOMRect.fromRect({ x: point.x, y: point.y, width: 0, height: 0 }),
  });

  const move = (key: WorkspaceKey) => {
    onClose();
    void moveToWorkspaceAndFollow(from, target, key);
  };

  const select = (index: number) => {
    setSelected(index);
    listRef.current
      ?.querySelector(`[data-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      select((current + step + rows.length) % rows.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[current];
      if (row) move(row.key);
    }
  };

  return (
    <>
      <Popover.Anchor virtualRef={anchor} />
      <Popover.Portal>
        <Popover.Content
          className={styles.picker}
          side="bottom"
          align="start"
          sideOffset={0}
          collisionPadding={8}
          data-testid="move-to-workspace-picker"
          aria-label="Move to workspace"
          // Not back to the menu's trigger: to the pane being looked at. After
          // a move that is the moved pane, which takes focus as it mounts.
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            useAppStore.getState().refocusActivePane();
          }}
        >
          <input
            ref={inputRef}
            className={styles.input}
            placeholder="Move to workspace…"
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
            aria-controls="move-to-workspace-list"
            aria-activedescendant={rows[current] ? `move-target-${current}` : undefined}
          />
          <div className={styles.list} id="move-to-workspace-list" role="listbox" ref={listRef}>
            {project && <div className={styles.heading}>{project.name}</div>}
            {rows.length === 0 ? (
              <div className={styles.empty}>No matching workspaces</div>
            ) : (
              rows.map((row, index) => (
                <TargetRow
                  key={row.key}
                  index={index}
                  targetKey={row.key}
                  label={row.label}
                  selected={index === current}
                  onHover={() => setSelected(index)}
                  onPick={() => move(row.key)}
                />
              ))
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </>
  );
}

/**
 * A remote project's main workspace is named for its box, as the sidebar
 * names it (`ProjectItem`).
 */
function useRemoteTarget(project: ProjectInfo | null): string | null {
  const serverName = useServerHostName(project?.hostId);
  const storeTarget = useHostStore((state) =>
    project ? remoteTargetForProject(project, state) : null,
  );
  return serverName === null ? storeTarget : null;
}

function TargetRow({
  index,
  targetKey,
  label,
  selected,
  onHover,
  onPick,
}: {
  index: number;
  targetKey: WorkspaceKey;
  label: string;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const { status, pulse } = useWorkspaceAgentStatus(targetKey);
  const indicator = toWorkspaceIndicator(status, pulse);
  const tabCount = useAppStore((s) => {
    const layout = s.workspaceLayouts[targetKey];
    if (!layout) return 0;
    return Object.values(layout.panels).reduce((n, panel) => n + panel.tabs.length, 0);
  });
  return (
    <div
      id={`move-target-${index}`}
      data-index={index}
      data-testid="move-to-workspace-target"
      data-workspace-key={targetKey}
      role="option"
      aria-selected={selected}
      data-selected={selected}
      className={styles.item}
      onMouseMove={selected ? undefined : onHover}
      onClick={onPick}
    >
      <span className={styles.indicator}>
        {indicator && <WorkspaceIndicatorDot indicator={indicator} />}
      </span>
      <span className={styles.label}>{label}</span>
      <span className={styles.meta}>
        {tabCount === 0 ? "empty" : tabCount === 1 ? "1 tab" : `${tabCount} tabs`}
      </span>
    </div>
  );
}
