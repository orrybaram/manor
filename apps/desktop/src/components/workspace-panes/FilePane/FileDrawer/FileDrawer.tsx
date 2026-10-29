import {
  createElement,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
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
import { useLayoutMode } from "../../../../hooks/useLayoutMode";
import { expandedForFiles, visibleTreeRows } from "../drawer-tree";
import type { FilesWorkspace } from "../open-file-watches";
import { changeBadge, foldersWithChanges, type FileChange } from "../file-changes";
import type { WorkspaceChanges } from "../workspace-changes";
import { useFileDrawerLayout } from "./file-drawer-layout";
import styles from "./FileDrawer.module.css";

const ROW_HEIGHT = 22;
/** A finger's row: `SourceControl.module.css`'s phone `.row` matches it. */
const PHONE_ROW_HEIGHT = 36;

/** The workspace's tree, or Source Control. */
export type DrawerMode = "files" | "scm";

type FileDrawerProps = {
  workspace: FilesWorkspace;
  mode: DrawerMode;
  /** The workspace's changed files and who wrote them; null until read. */
  changes: WorkspaceChanges | null;
  /** The pane's open file, workspace-relative; its folders start open. */
  openFile: string | null;
  /** Offer "+" (new file). Not on the phone, which only reads. */
  canCreate: boolean;
  onPick: (path: string) => void;
  onClose: () => void;
  /** Its edge: resizes it, and collapses it into the strip. */
  resizeHandle?: ReactNode;
  /** Source Control's head controls (its Local/Branch toggle). */
  scmHead?: ReactNode;
  /** Source Control's list, shown in place of the tree. */
  scm?: ReactNode;
};

/**
 * The drawer beside the editor (over it, on a phone). Files: the workspace's tree, listed each time
 * it opens (one `files.list`), starting with only the folders on the way to
 * the open file and to changed files expanded; changed files carry their
 * badge and their folders a dot. Source Control: whatever the pane renders
 * for it (`SourceControl`).
 */
export function FileDrawer({
  workspace,
  mode,
  changes,
  openFile,
  canCreate,
  onPick,
  onClose,
  resizeHandle,
  scmHead,
  scm,
}: FileDrawerProps) {
  const width = useFileDrawerLayout((s) => s.width);
  const drawerRef = useRef<HTMLDivElement>(null);
  const queryKey = ["files.list", workspace.hostId, workspace.path];
  const listing = useQuery({
    queryKey,
    queryFn: () => window.electronAPI.files.list(workspace),
    staleTime: 0,
    enabled: mode === "files",
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
      data-mode={mode}
      style={{ "--drawer-width": `${width}px` } as CSSProperties}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div className={styles.head}>
        <span>{mode === "scm" ? "Source Control" : "Files"}</span>
        <span className={styles.headSpacer} />
        {mode === "scm" && scmHead}
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
      {mode === "scm" ? (
        scm
      ) : listing.data ? (
        <TreeList
          paths={listing.data.paths}
          truncated={listing.data.truncated}
          changes={changes?.files ?? null}
          openFile={openFile}
          onPick={onPick}
        />
      ) : (
        <div className={styles.note} data-testid="file-pane-drawer-status">
          {listing.isError ? ipcErrorMessage(listing.error) : "Loading…"}
        </div>
      )}
      {resizeHandle}
    </div>
  );
}

function TreeList({
  paths,
  truncated,
  changes,
  openFile,
  onPick,
}: {
  paths: string[];
  truncated: boolean;
  changes: ReadonlyMap<string, FileChange> | null;
  openFile: string | null;
  onPick: (path: string) => void;
}) {
  const tree = useMemo(() => buildFileTree(paths.map((path) => ({ path }))), [paths]);
  // Null until the user toggles a folder: until then, the folders of the
  // open file and of the changed files.
  const [toggled, setToggled] = useState<Set<string> | null>(null);
  const expanded = useMemo(
    () => toggled ?? expandedForFiles(tree, openFile, changes?.keys() ?? []),
    [toggled, tree, openFile, changes],
  );
  const dotted = useMemo(() => foldersWithChanges(changes?.keys() ?? []), [changes]);
  const rows = useMemo(() => visibleTreeRows(tree, expanded), [tree, expanded]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = useLayoutMode() === "phone" ? PHONE_ROW_HEIGHT : ROW_HEIGHT;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });
  // Open on the open file, a few rows down from the top. Scrolled to once
  // mounted rather than passed as `initialOffset`: an offset past the end of
  // a short tree has the browser clamp the scroll while the virtualizer keeps
  // the offset, and it leaves the rows above blank, the list floating mid-way.
  useMountEffect(() => {
    const index = openFile ? rows.findIndex((r) => r.path === openFile) : -1;
    if (index > 3) virtualizer.scrollToIndex(index - 3, { align: "start" });
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
              style={{ transform: `translateY(${item.start}px)`, height: rowHeight }}
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
                  trailing={
                    dotted.has(row.path) ? (
                      <span
                        className={styles.dirDot}
                        data-testid="file-pane-dir-dot"
                        title="Holds changed files"
                      />
                    ) : undefined
                  }
                />
              ) : (
                <FileRow
                  path={row.path}
                  name={row.name}
                  depth={row.depth}
                  change={changes?.get(row.path) ?? null}
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
  change,
  selected,
  onPick,
}: {
  path: string;
  name: string;
  depth: number;
  change: FileChange | null;
  selected: boolean;
  onPick: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.fileRow} ${selected ? styles.fileRowSelected : ""} ${change ? styles[`status_${change.status}`] : ""}`}
      style={{ paddingLeft: treeRowIndent(depth) }}
      title={path}
      aria-current={selected ? "true" : undefined}
      data-change={change?.status}
      onClick={() => onPick(path)}
    >
      {createElement(fileIconFor(path), { size: 12, className: styles.fileIcon })}
      <span className={styles.fileName}>{name}</span>
      {change && <ChangeBadge change={change} />}
    </button>
  );
}

function ChangeBadge({ change }: { change: FileChange }) {
  return (
    <span className={styles.badge} data-testid="file-pane-change-badge">
      {changeBadge(change.status)}
    </span>
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
