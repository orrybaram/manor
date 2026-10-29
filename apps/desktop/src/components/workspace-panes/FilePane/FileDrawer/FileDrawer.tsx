import { createElement, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { buildFileTree } from "../../FileTree/file-tree";
import { DirRow } from "../../FileTree/DirRow/DirRow";
import { fileIconFor } from "../../FileTree/file-icon";
import { treeRowIndent } from "../../FileTree/indent";
import { ipcErrorMessage } from "../../../../lib/ipc-error";
import { useMountEffect } from "../../../../hooks/useMountEffect";
import { expandedForOpenFile, visibleTreeRows } from "../drawer-tree";
import type { FilesWorkspace } from "../open-file-watches";
import styles from "./FileDrawer.module.css";

const ROW_HEIGHT = 22;

type FileDrawerProps = {
  workspace: FilesWorkspace;
  /** The pane's open file, workspace-relative; its folders start open. */
  openFile: string | null;
  onPick: (path: string) => void;
  onClose: () => void;
};

/**
 * The Files drawer: the workspace's tree, over the editor. It lists the
 * workspace each time it opens (one `files.list`), and starts with only the
 * folders on the way to the open file expanded.
 */
export function FileDrawer({ workspace, openFile, onPick, onClose }: FileDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const listing = useQuery({
    queryKey: ["files.list", workspace.hostId, workspace.path],
    queryFn: () => window.electronAPI.files.list(workspace),
    staleTime: 0,
  });

  // Escape reaches the drawer wherever focus was: it takes the keyboard.
  useMountEffect(() => {
    drawerRef.current?.focus({ preventScroll: true });
  });

  return (
    <div
      ref={drawerRef}
      className={styles.drawer}
      data-testid="file-pane-drawer"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div className={styles.head}>
        <span>Files</span>
      </div>
      {listing.data ? (
        <TreeList
          paths={listing.data.paths}
          truncated={listing.data.truncated}
          openFile={openFile}
          onPick={onPick}
        />
      ) : (
        <div className={styles.note} data-testid="file-pane-drawer-status">
          {listing.isError ? ipcErrorMessage(listing.error) : "Loading…"}
        </div>
      )}
    </div>
  );
}

function TreeList({
  paths,
  truncated,
  openFile,
  onPick,
}: {
  paths: string[];
  truncated: boolean;
  openFile: string | null;
  onPick: (path: string) => void;
}) {
  const tree = useMemo(() => buildFileTree(paths.map((path) => ({ path }))), [paths]);
  // Null until the user toggles a folder: until then, the open file's folders.
  const [toggled, setToggled] = useState<Set<string> | null>(null);
  const expanded = useMemo(
    () => toggled ?? expandedForOpenFile(tree, openFile),
    [toggled, tree, openFile],
  );
  const rows = useMemo(() => visibleTreeRows(tree, expanded), [tree, expanded]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Open on the open file, a few rows down from the top.
  const [initialOffset] = useState(() => {
    const index = openFile ? rows.findIndex((r) => r.path === openFile) : -1;
    return Math.max(0, (index - 3) * ROW_HEIGHT);
  });
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    initialOffset,
  });

  const toggle = (path: string) =>
    setToggled((prev) => {
      const next = new Set(prev ?? expanded);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  if (rows.length === 0) {
    return <div className={styles.note}>No files</div>;
  }

  return (
    <div ref={scrollRef} className={styles.tree} data-testid="file-pane-tree">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          return (
            <div
              key={`${row.kind}:${row.path}`}
              className={styles.row}
              style={{ transform: `translateY(${item.start}px)`, height: ROW_HEIGHT }}
              data-testid="file-pane-tree-row"
              data-kind={row.kind}
              data-path={row.path}
            >
              {row.kind === "dir" ? (
                <DirRow
                  name={row.name}
                  depth={row.depth}
                  collapsed={!row.expanded}
                  onToggle={() => toggle(row.path)}
                />
              ) : (
                <FileRow
                  path={row.path}
                  name={row.name}
                  depth={row.depth}
                  selected={row.path === openFile}
                  onPick={onPick}
                />
              )}
            </div>
          );
        })}
      </div>
      {truncated && (
        <div className={styles.note}>Showing the first {paths.length.toLocaleString()} files</div>
      )}
    </div>
  );
}

function FileRow({
  path,
  name,
  depth,
  selected,
  onPick,
}: {
  path: string;
  name: string;
  depth: number;
  selected: boolean;
  onPick: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.fileRow} ${selected ? styles.fileRowSelected : ""}`}
      style={{ paddingLeft: treeRowIndent(depth) }}
      title={path}
      aria-current={selected ? "true" : undefined}
      onClick={() => onPick(path)}
    >
      {createElement(fileIconFor(path), { size: 12, className: styles.fileIcon })}
      <span className={styles.fileName}>{name}</span>
    </button>
  );
}

