import {
  createElement,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as ContextMenu from "@radix-ui/react-context-menu";
import Plus from "lucide-react/dist/esm/icons/plus";
import { useVirtualizer } from "@tanstack/react-virtual";
import { buildFileTree } from "../../FileTree/file-tree";
import { DirRow } from "../../FileTree/DirRow/DirRow";
import { fileIconFor } from "../../FileTree/file-icon";
import { treeRowIndent } from "../../FileTree/indent";
import { ipcErrorMessage } from "../../../../lib/ipc-error";
import { Tooltip } from "../../../ui/Tooltip/Tooltip";
import { ConfirmDialog } from "../../../ui/ConfirmDialog/ConfirmDialog";
import { toast } from "../../../../toast";
import { useMountEffect } from "../../../../hooks/useMountEffect";
import { useLayoutMode } from "../../../../hooks/useLayoutMode";
import { expandedForFiles, visibleTreeRows } from "../drawer-tree";
import type { FilesWorkspace } from "../open-file-watches";
import {
  changeBadge,
  foldersWithChanges,
  groupChangesByAuthor,
  type FileChange,
} from "../file-changes";
import type { WorkspaceChanges } from "../workspace-changes";
import { AgentChip } from "../AgentChip";
import { useFileDrawerLayout } from "./file-drawer-layout";
import { TreeRowMenu, type MenuTarget } from "./TreeRowMenu";
import styles from "./FileDrawer.module.css";

const ROW_HEIGHT = 22;
/** A finger's row: `FileDrawer.module.css`'s phone `.changeRow` matches it. */
const PHONE_ROW_HEIGHT = 36;

/** The workspace's tree, or the flat list of its changed files by agent. */
export type DrawerMode = "files" | "changes";

type FileDrawerProps = {
  workspace: FilesWorkspace;
  mode: DrawerMode;
  /** The workspace's changed files and who wrote them; null until read. */
  changes: WorkspaceChanges | null;
  /** The pane's open file, workspace-relative; its folders start open. */
  openFile: string | null;
  /** Offer "+" (new file), Rename and Delete. Not on the phone, which only reads. */
  canWrite: boolean;
  /** The open file has unsaved edits: it can't be renamed from under them. */
  openFileDirty: boolean;
  onPick: (path: string) => void;
  /** A file was renamed from the tree; the pane follows its open file. */
  onRenamed: (from: string, to: string) => void;
  onClose: () => void;
  /** Its edge: resizes it, and collapses it into the strip. */
  resizeHandle?: ReactNode;
};

/**
 * The drawer beside the editor (over it, on a phone). Files: the workspace's tree, listed each time
 * it opens (one `files.list`), starting with only the folders on the way to
 * the open file and to changed files expanded; changed files carry their
 * badge and their folders a dot. Changed by agents: the changed files, flat,
 * under the agent that last wrote each.
 */
export function FileDrawer({
  workspace,
  mode,
  changes,
  openFile,
  canWrite,
  openFileDirty,
  onPick,
  onRenamed,
  onClose,
  resizeHandle,
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
        <span>{mode === "changes" ? "Changed by agents" : "Files"}</span>
        <span className={styles.headSpacer} />
        {canWrite && (
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
      {mode === "changes" ? (
        <ChangesList changes={changes} openFile={openFile} onPick={onPick} />
      ) : listing.data ? (
        <TreeList
          workspace={workspace}
          canWrite={canWrite}
          openFileDirty={openFileDirty}
          onRenamed={(from, to) => {
            void queryClient.invalidateQueries({ queryKey });
            onRenamed(from, to);
          }}
          onDeleted={() => void queryClient.invalidateQueries({ queryKey })}
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
  workspace,
  canWrite,
  openFileDirty,
  onRenamed,
  onDeleted,
  paths,
  truncated,
  changes,
  openFile,
  onPick,
}: {
  workspace: FilesWorkspace;
  canWrite: boolean;
  openFileDirty: boolean;
  onRenamed: (from: string, to: string) => void;
  onDeleted: () => void;
  paths: string[];
  truncated: boolean;
  changes: ReadonlyMap<string, FileChange> | null;
  openFile: string | null;
  onPick: (path: string) => void;
}) {
  const tree = useMemo(
    () => buildFileTree(paths.map((path) => ({ path }))),
    [paths],
  );
  // Null until the user toggles a folder: until then, the folders of the
  // open file and of the changed files.
  const [toggled, setToggled] = useState<Set<string> | null>(null);
  const expanded = useMemo(
    () => toggled ?? expandedForFiles(tree, openFile, changes?.keys() ?? []),
    [toggled, tree, openFile, changes],
  );
  const dotted = useMemo(
    () => foldersWithChanges(changes?.keys() ?? []),
    [changes],
  );
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

  // The row right-clicked, while its menu is open; the file being renamed in
  // its row; the file waiting on Delete's confirmation.
  const [menuTarget, setMenuTarget] = useState<MenuTarget | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  // Rename picked from the menu: its input mounts once the menu has closed,
  // or the menu's focus handling takes the focus back from it.
  const pendingRename = useRef<string | null>(null);

  const deleteFile = async (path: string) => {
    try {
      const result = await window.electronAPI.files.delete(workspace, path);
      if (!result.ok)
        toast.error("Couldn't delete the file", { detail: result.message });
      else onDeleted();
    } catch (err) {
      toast.error("Couldn't delete the file", { error: err });
    }
    setDeleting(null);
  };

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
    <ContextMenu.Root onOpenChange={(open) => !open && setMenuTarget(null)}>
      <ContextMenu.Trigger asChild>
        <div
          ref={scrollRef}
          className={styles.tree}
          data-testid="file-pane-tree"
          onContextMenu={(e) => {
            const row = (e.target as HTMLElement).closest<HTMLElement>(
              "[data-path]",
            );
            const kind = row?.dataset.kind;
            // Nothing to offer off a row, or on the row being renamed (its input's own menu).
            if (
              !row ||
              (kind !== "file" && kind !== "dir") ||
              row.dataset.path === renaming
            ) {
              e.preventDefault();
              return;
            }
            setMenuTarget({ kind, path: row.dataset.path! });
          }}
        >
          <div
            style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              return (
                <div
                  key={`${row.kind}:${row.path}`}
                  className={`${styles.row} ${menuTarget?.path === row.path ? styles.rowMenuOpen : ""}`}
                  style={{
                    transform: `translateY(${item.start}px)`,
                    height: rowHeight,
                  }}
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
                  ) : row.path === renaming ? (
                    <RenameInput
                      workspace={workspace}
                      path={row.path}
                      name={row.name}
                      depth={row.depth}
                      onRenamed={(to) => {
                        setRenaming(null);
                        onRenamed(row.path, to);
                      }}
                      onCancel={() => setRenaming(null)}
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
            <div className={styles.note}>
              Showing the first {paths.length.toLocaleString()} files
            </div>
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        {menuTarget && (
          <TreeRowMenu
            workspace={workspace}
            target={menuTarget}
            canWrite={canWrite}
            renameBlocked={
              menuTarget.path === openFile && openFileDirty
                ? "Save or discard your edits first"
                : null
            }
            onRename={(path) => {
              pendingRename.current = path;
            }}
            onDelete={setDeleting}
            onClosed={() => {
              if (pendingRename.current === null) return;
              setRenaming(pendingRename.current);
              pendingRename.current = null;
            }}
          />
        )}
      </ContextMenu.Portal>
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.slice(deleting.lastIndexOf("/") + 1) ?? ""}?`}
        description={`${deleting ?? ""} is deleted from the workspace. This can't be undone.`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => (deleting ? deleteFile(deleting) : undefined)}
        onCancel={() => setDeleting(null)}
      />
    </ContextMenu.Root>
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
      {createElement(fileIconFor(path), {
        size: 12,
        className: styles.fileIcon,
      })}
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

/**
 * Changed by agents: each agent's changed files under its chip, the latest
 * writer first, then the files no agent's hooks claimed. A deleted file is
 * listed but has nothing to open.
 */
function ChangesList({
  changes,
  openFile,
  onPick,
}: {
  changes: WorkspaceChanges | null;
  openFile: string | null;
  onPick: (path: string) => void;
}) {
  const groups = useMemo(
    () =>
      changes
        ? groupChangesByAuthor(changes.files.values(), changes.authors)
        : [],
    [changes],
  );
  if (!changes) {
    return (
      <div className={styles.note} data-testid="file-pane-drawer-status">
        Loading…
      </div>
    );
  }
  if (groups.length === 0) {
    return (
      <div className={styles.note} data-testid="file-pane-changes-empty">
        No changes
      </div>
    );
  }
  return (
    <div className={styles.tree} data-testid="file-pane-changes">
      {groups.map((group) => (
        <div
          key={group.author?.paneId ?? ""}
          className={styles.group}
          data-testid="file-pane-changes-group"
        >
          <div className={styles.groupHead}>
            {group.author ? (
              <AgentChip author={group.author} />
            ) : (
              <span className={styles.groupLabel}>Other changes</span>
            )}
          </div>
          {group.files.map((change) => {
            const slash = change.path.lastIndexOf("/");
            const name = change.path.slice(slash + 1);
            const folder = slash < 0 ? "" : change.path.slice(0, slash);
            const deleted = change.status === "deleted";
            const selected = change.path === openFile;
            return (
              <button
                key={change.path}
                type="button"
                className={`${styles.fileRow} ${styles.changeRow} ${selected ? styles.fileRowSelected : ""} ${styles[`status_${change.status}`]}`}
                title={deleted ? `${change.path} (deleted)` : change.path}
                disabled={deleted}
                aria-current={selected ? "true" : undefined}
                data-testid="file-pane-change-row"
                data-path={change.path}
                data-change={change.status}
                onClick={() => onPick(change.path)}
              >
                {createElement(fileIconFor(change.path), {
                  size: 12,
                  className: styles.fileIcon,
                })}
                <span className={styles.fileName}>{name}</span>
                {folder && <span className={styles.folder}>{folder}</span>}
                <ChangeBadge change={change} />
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * A file's row turned into its name, editable: Enter moves it with
 * `files.rename` (a name with `/` in it moves it into that folder, relative to
 * its own), Escape or leaving the row lets it go.
 */
function RenameInput({
  workspace,
  path,
  name,
  depth,
  onRenamed,
  onCancel,
}: {
  workspace: FilesWorkspace;
  path: string;
  name: string;
  depth: number;
  onRenamed: (to: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);

  const rename = async () => {
    const next = value.trim();
    if (busy) return;
    if (!next || next === name) {
      onCancel();
      return;
    }
    if (next.endsWith("/")) return;
    const to = folderOf(path) + next;
    setBusy(true);
    try {
      const result = await window.electronAPI.files.rename(workspace, path, to);
      if (result.ok) {
        onRenamed(to);
        return;
      }
      toast.error("Couldn't rename the file", { detail: result.message });
    } catch (err) {
      toast.error("Couldn't rename the file", { error: err });
    }
    setBusy(false);
  };

  return (
    <div
      className={styles.renameRow}
      style={{ paddingLeft: treeRowIndent(depth) }}
    >
      {createElement(fileIconFor(path), {
        size: 12,
        className: styles.fileIcon,
      })}
      <input
        className={styles.renameInput}
        data-testid="file-pane-rename-input"
        aria-label={`Rename ${name}`}
        value={value}
        spellCheck={false}
        autoFocus
        disabled={busy}
        onFocus={(e) => {
          // The name without its extension, as Finder and VS Code select it.
          const dot = name.lastIndexOf(".");
          e.currentTarget.setSelectionRange(0, dot > 0 ? dot : name.length);
        }}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          if (!busy) onCancel();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void rename();
          } else if (e.key === "Escape") {
            // The drawer would close on it; here it only drops the rename.
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
    </div>
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
        <div
          className={styles.newFileError}
          data-testid="file-pane-new-file-error"
          role="alert"
        >
          {error}
        </div>
      )}
    </div>
  );
}
