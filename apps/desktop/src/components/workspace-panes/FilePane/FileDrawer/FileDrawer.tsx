import { createElement, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Plus from "lucide-react/dist/esm/icons/plus";
import { useVirtualizer } from "@tanstack/react-virtual";
import { buildFileTree } from "../../FileTree/file-tree";
import { DirRow } from "../../FileTree/DirRow/DirRow";
import { fileIconFor } from "../../FileTree/file-icon";
import { treeRowIndent } from "../../FileTree/indent";
import { ipcErrorMessage } from "../../../../lib/ipc-error";
import { Tooltip } from "../../../ui/Tooltip/Tooltip";
import { useMountEffect } from "../../../../hooks/useMountEffect";
import { expandedForOpenFile, visibleTreeRows } from "../drawer-tree";
import type { FilesWorkspace } from "../open-file-watches";
import styles from "./FileDrawer.module.css";

const ROW_HEIGHT = 22;

type FileDrawerProps = {
  workspace: FilesWorkspace;
  /** The pane's open file, workspace-relative; its folders start open. */
  openFile: string | null;
  /** Offer "+" (new file). Not on the phone, which only reads. */
  canCreate: boolean;
  onPick: (path: string) => void;
  onClose: () => void;
};

/**
 * The Files drawer: the workspace's tree, over the editor. It lists the
 * workspace each time it opens (one `files.list`), and starts with only the
 * folders on the way to the open file expanded.
 */
export function FileDrawer({
  workspace,
  openFile,
  canCreate,
  onPick,
  onClose,
}: FileDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const queryKey = ["files.list", workspace.hostId, workspace.path];
  const listing = useQuery({
    queryKey,
    queryFn: () => window.electronAPI.files.list(workspace),
    staleTime: 0,
  });
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

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
        <span className={styles.headSpacer} />
        {canCreate && (
          <Tooltip label="New file">
            <button
              type="button"
              className={styles.headBtn}
              aria-label="New file"
              data-testid="file-pane-new-file"
              onClick={() => setCreating(true)}
            >
              <Plus size={13} />
            </button>
          </Tooltip>
        )}
      </div>
      {creating && (
        <NewFileInput
          workspace={workspace}
          initial={folderOf(openFile)}
          onCreated={(path) => {
            setCreating(false);
            void queryClient.invalidateQueries({ queryKey });
            onPick(path);
          }}
          onCancel={() => {
            setCreating(false);
            drawerRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
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


/** "src/app/" for "src/app/main.ts"; empty at the root or with nothing open. */
function folderOf(path: string | null): string {
  if (!path) return "";
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash + 1);
}

/**
 * The new-file row at the top of the tree: a workspace-relative path, made
 * empty on Enter with `files.create`, then opened. Escape lets it go.
 */
function NewFileInput({
  workspace,
  initial,
  onCreated,
  onCancel,
}: {
  workspace: FilesWorkspace;
  initial: string;
  onCreated: (path: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    const path = value.trim();
    if (!path || path.endsWith("/") || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.files.create(workspace, path);
      if (result.ok) {
        onCreated(path);
        return;
      }
      setError(result.message);
    } catch (err) {
      setError(ipcErrorMessage(err));
    }
    setBusy(false);
  };

  return (
    <div className={styles.newFile}>
      <input
        className={styles.newFileInput}
        data-testid="file-pane-new-file-input"
        aria-label="New file path"
        placeholder="path/to/file"
        value={value}
        spellCheck={false}
        autoFocus
        disabled={busy}
        onFocus={(e) => {
          const end = e.currentTarget.value.length;
          e.currentTarget.setSelectionRange(end, end);
        }}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void create();
          } else if (e.key === "Escape") {
            // The drawer would close on it; here it only drops the row.
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      {error !== null && (
        <div className={styles.newFileError} data-testid="file-pane-new-file-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
