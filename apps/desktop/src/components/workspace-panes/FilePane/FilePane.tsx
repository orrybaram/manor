import { lazy, Suspense, useMemo, useRef, useState, type ReactNode } from "react";
import Folder from "lucide-react/dist/esm/icons/folder";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import {
  useAppStore,
  usePaneFilePath,
  selectHasPane,
  selectPaneContentType,
} from "../../../store/app-store";
import {
  useOpenFileStore,
  hasUnsavedEdits,
  noteDiskChangeDuringSave,
  registerOpenFileEditor,
  saveOpenFile,
} from "../../../store/open-file-store";
import { useProjectStore } from "../../../store/project-store";
import { ownerOf } from "../../../lib/workspace-directory";
import { LOCAL_HOST_ID, workspaceKey } from "../../../lib/workspace-key";
import { getPlatform } from "../../../lib/keybindings";
import { isWebApp } from "../../../lib/platform";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { useLayoutMode } from "../../../hooks/useLayoutMode";
import { ipcErrorMessage } from "../../../lib/ipc-error";
import { fileTitle } from "../../../lib/pane-title";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import { Button } from "../../ui/Button/Button";
import type { AgentMarksSource, CodeEditorRef } from "./CodeEditor/CodeEditor";
import type { AgentMarks } from "./CodeEditor/change-marks";
import { FileDrawer, type DrawerMode } from "./FileDrawer/FileDrawer";
import { FileDrawerResizeHandle } from "./FileDrawer/FileDrawerResizeHandle";
import { useAgentLabel } from "./agent-label";
import type { FileChange } from "./file-changes";
import { fetchDiffSingleFlight } from "../DiffPane/diff-fetch";
import { FingerprintedFetch } from "../DiffPane/FingerprintedFetch";
import { baseFromDiff, fileDiffIn, followDiffBase, type HeldBase } from "./diff-base";
import { SourceControl, ScmViewToggle } from "./SourceControl/SourceControl";
import type { ScmView } from "./SourceControl/scm-entries";
import { followWorkspaceChanges, useWorkspaceChanges } from "./workspace-changes";
import { openFileWatches, type FilesWorkspace } from "./open-file-watches";
import { createLatestOnly } from "./latest-only";
import { pendingLines } from "./pending-line";
import { pendingComments } from "./pending-comment";
import { ReviewSection } from "./SourceControl/ReviewSection";
import { ReviewBar } from "../../review/ReviewSend/ReviewSend";
import type { DraftComment } from "../../../store/review-store";
import {
  diskChangeAction,
  sameWorkspace,
  type OpenFileEvent,
  type OpenFileState,
} from "./open-file-state";
import styles from "./FilePane.module.css";

// CodeMirror is its own chunk: nothing loads it until a file pane opens a file.
const CodeEditor = lazy(() =>
  import("./CodeEditor/CodeEditor").then((m) => ({ default: m.CodeEditor })),
);
// A deleted file's diff: its own small read-only view.
const DeletedFileView = lazy(() =>
  import("./CodeEditor/DeletedFileView").then((m) => ({ default: m.DeletedFileView })),
);
// The merge view loads only when Compare is pressed.
const CompareView = lazy(() =>
  import("./CompareView/CompareView").then((m) => ({ default: m.CompareView })),
);

type FilePaneProps = {
  paneId: string;
  workspacePath?: string;
  hostId?: string;
};

type Drawer = DrawerMode | null;

/**
 * A change's diff the editor is showing: which file, and against HEAD
 * (Local) or the project's default branch (Branch). A deleted file has no
 * working copy to open, so its diff shows in place of the open file.
 */
type DiffShown = {
  path: string;
  view: ScmView;
  deleted: boolean;
  /** A deleted file's diff: the file its Close diff goes back to. */
  returnTo?: string | null;
};

/** The raw diff a shown diff is read from, and what it is against. */
type DiffSource = {
  view: ScmView;
  /** "HEAD", or the default branch's name. */
  against: string;
  /** Undefined until first read. */
  raw: string | null | undefined;
  error: string | null;
};

/**
 * A file pane: one file of its workspace, with a strip on its left edge whose
 * Files button opens the workspace's tree in a drawer beside the editor, and
 * whose Source Control button opens the workspace's changes, to stage,
 * discard and open. The
 * drawer resizes and collapses from its edge, as the app sidebar does; on a
 * phone it floats over the editor instead, and closes once it has done its
 * job. The
 * open file lives on the pane's leaf (`setPaneFilePath`), so it is the same
 * in every window and after a relaunch; its unsaved edits live in
 * `open-file-store`, so a remount keeps them. The phone (the web client)
 * shows it read-only; a narrow desktop window still edits.
 */
export function FilePane({ paneId, workspacePath, hostId }: FilePaneProps) {
  const filePath = usePaneFilePath(paneId);
  const setPaneFilePath = useAppStore((s) => s.setPaneFilePath);
  // Read-only is the web client's, whatever the window's width.
  const readOnly = isWebApp();
  // A pane with nothing open starts on its tree.
  const [drawer, setDrawer] = useState<Drawer>(() => (filePath ? null : "files"));
  // Local or Branch: kept while the drawer closes and opens, not on the leaf.
  const [scmView, setScmView] = useState<ScmView>("local");
  // A Source Control row shows its file's diff; local state, as the drawer is.
  const [diff, setDiff] = useState<DiffShown | null>(null);
  // The view an open waiting on the swap bar brings with it (a row's diff, or
  // the tree's plain file), adopted only once that open happens: a Cancel
  // leaves the file as it was shown.
  const [next, setNext] = useState<{ path: string; diff: DiffShown | null } | null>(null);
  const floating = useLayoutMode() === "phone";
  const floatingRef = useRef(floating);
  floatingRef.current = floating;
  // A file sent here from elsewhere (the diff pane, a terminal link), or the
  // swap bar asking about one, puts the editor back in view: only a floating
  // drawer hides it.
  const pendingOpen = useOpenFileStore((s) => s.byPane[paneId]?.pendingOpen ?? null);
  const [shownFor, setShownFor] = useState({ filePath, pendingOpen });
  if (shownFor.filePath !== filePath || shownFor.pendingOpen !== pendingOpen) {
    setShownFor({ filePath, pendingOpen });
    if (floating && (filePath !== shownFor.filePath || pendingOpen)) setDrawer(null);
    // Another file opened: the view it was asked with, else the plain file
    // (a diff is for its own file only).
    if (filePath !== shownFor.filePath) {
      setDiff(next && next.path === filePath ? next.diff : diff?.path === filePath ? diff : null);
      setNext(null);
    }
  }
  // The same file sent again only moves the cursor; it still wants the
  // editor, and a terminal link or ⌘P means the plain file.
  useMountEffect(() =>
    pendingLines.subscribe(paneId, () => {
      setDiff(null);
      setNext(null);
      if (floatingRef.current) setDrawer(null);
    }),
  );
  const workspace = useMemo<FilesWorkspace | null>(
    () =>
      workspacePath ? { path: workspacePath, hostId: hostId ?? LOCAL_HOST_ID } : null,
    [workspacePath, hostId],
  );
  const changes = useWorkspaceChanges(workspace);
  const changeCount = changes?.files.size ?? 0;

  // Branch diffs are fetched as Source Control fetches its Branch list, under
  // the same key, so the two share one `git diff`; Local's is the one above.
  const wsKey = workspace ? workspaceKey(workspace.hostId, workspace.path) : null;
  const defaultBranch =
    useProjectStore((s) => (wsKey ? ownerOf(s.projects, wsKey)?.defaultBranch : undefined)) ??
    "main";
  const branchKey = wsKey ? `${wsKey}\u0000branch\u0000${defaultBranch}` : null;
  const [branchResult, setBranchResult] = useState<{
    key: string;
    raw: string | null;
    error: string | null;
  } | null>(null);
  const branch = branchResult && branchResult.key === branchKey ? branchResult : null;
  const diffSource: DiffSource | null = !diff
    ? null
    : diff.view === "local"
      ? { view: "local", against: "HEAD", raw: changes ? changes.raw : undefined, error: null }
      : {
          view: "branch",
          against: defaultBranch,
          raw: branch ? branch.raw : undefined,
          error: branch?.error ?? null,
        };

  // A split rebuilds the pane, so its edits outlive the mount; a closed
  // pane's go, and so do those of a pane that is no longer a file pane.
  useMountEffect(() => () => {
    const app = useAppStore.getState();
    if (!selectHasPane(app, paneId) || selectPaneContentType(app, paneId) !== "file") {
      useOpenFileStore.getState().drop(paneId);
    }
  });

  /** Open `path` shown as `shown` (its diff, or null for the plain file). */
  const open = (path: string, shown: DiffShown | null) => {
    // Another open supersedes a comment jump still waiting on its diff.
    pendingComments.clearLine(paneId);
    if (floating) setDrawer(null);
    // Unsaved edits ask first, in the swap bar, even for a deleted file's
    // diff, which takes the editor's place.
    if (path !== filePath && hasUnsavedEdits(paneId)) {
      setNext({ path, diff: shown });
      useOpenFileStore.getState().dispatch(paneId, { type: "ask-before-open", path });
      return;
    }
    setNext(null);
    setDiff(shown);
    // A deleted file has nothing to open: its diff shows over the open file.
    if (path !== filePath && !shown?.deleted) setPaneFilePath(paneId, path);
  };

  // The tree opens the plain file.
  const pickFile = (path: string) => open(path, null);
  // A Source Control row opens its file's diff.
  const openChange = (change: FileChange, view: ScmView) =>
    open(change.path, {
      path: change.path,
      view,
      deleted: change.status === "deleted",
      returnTo: filePath,
    });
  // A review comment opens its file's diff, as its row would, and its card
  // is lit once the diff shows. Its view is the one showing that file, else
  // the drawer's, unless the file has no working changes to show it in.
  const jumpToComment = (comment: DraftComment) => {
    const path = comment.filePath;
    const view: ScmView =
      diff && !diff.deleted && diff.path === path
        ? diff.view
        : scmView === "local" && changes && !changes.files.has(path)
          ? "branch"
          : scmView;
    open(path, { path, view, deleted: false, returnTo: filePath });
    // A Diff pane comment has no line of the file: its file's diff is as near as it gets.
    if (comment.startLine !== undefined) {
      pendingComments.request(paneId, { path, commentId: comment.id });
    }
  };
  // A deleted file's diff closed: back to the file it was opened over.
  const closeDeleted = (returnTo: string | null | undefined) => {
    setDiff(null);
    if (returnTo && returnTo !== filePath) setPaneFilePath(paneId, returnTo);
  };

  // Dragged out of the strip, the drawer opens on the tree.
  const openDrawer = () => setDrawer((d) => d ?? "files");
  const collapseDrawer = () => setDrawer(null);
  const openHandle = (
    <FileDrawerResizeHandle open onOpen={openDrawer} onCollapse={collapseDrawer} />
  );
  const collapsedHandle = (
    <FileDrawerResizeHandle open={false} onOpen={openDrawer} onCollapse={collapseDrawer} />
  );

  return (
    <div className={styles.filePane} data-testid="file-pane">
      {diff?.view === "branch" && workspace && wsKey && branchKey && (
        <FingerprintedFetch
          key={branchKey}
          wsKey={wsKey}
          fetch={() =>
            fetchDiffSingleFlight(branchKey, () =>
              window.electronAPI.diffs.getFullDiff(workspace.path, defaultBranch),
            )
          }
          onResult={(raw) =>
            setBranchResult((prev) =>
              prev?.key === branchKey && prev.raw === raw && prev.error === null
                ? prev
                : { key: branchKey, raw, error: null },
            )
          }
          onError={(err) =>
            setBranchResult({
              key: branchKey,
              raw: null,
              error: err instanceof Error ? err.message : "Failed to load diff",
            })
          }
        />
      )}
      <div className={styles.strip}>
        <Tooltip label="Files">
          <button
            type="button"
            className={`${styles.stripBtn} ${drawer === "files" ? styles.stripBtnOn : ""}`}
            aria-label="Files"
            aria-pressed={drawer === "files"}
            data-testid="file-pane-files-button"
            onClick={() => setDrawer((d) => (d === "files" ? null : "files"))}
          >
            <Folder size={14} />
          </button>
        </Tooltip>
        <Tooltip label="Source Control">
          <button
            type="button"
            className={`${styles.stripBtn} ${drawer === "scm" ? styles.stripBtnOn : ""}`}
            aria-label={`Source Control${changeCount > 0 ? ` (${changeCount})` : ""}`}
            aria-pressed={drawer === "scm"}
            data-testid="file-pane-scm-button"
            disabled={!workspace}
            onClick={() => setDrawer((d) => (d === "scm" ? null : "scm"))}
          >
            <GitBranch size={14} />
            {changeCount > 0 && (
              <span className={styles.count} data-testid="file-pane-scm-count">
                {changeCount > 99 ? "99+" : changeCount}
              </span>
            )}
          </button>
        </Tooltip>
        {!floating && !drawer && workspace && collapsedHandle}
      </div>
      {drawer && workspace && (
        <FileDrawer
          key={drawer}
          workspace={workspace}
          mode={drawer}
          changes={changes}
          openFile={filePath}
          canCreate={!readOnly && drawer === "files"}
          onPick={pickFile}
          onClose={() => setDrawer(null)}
          resizeHandle={floating ? undefined : openHandle}
          scmHead={<ScmViewToggle value={scmView} onChange={setScmView} />}
          scm={
            <>
              <SourceControl
                workspace={workspace}
                view={scmView}
                changes={changes}
                openFile={filePath}
                onOpenChange={openChange}
                onOpenFile={pickFile}
              />
              <ReviewSection workspacePath={workspace.path} hostId={hostId} onJump={jumpToComment} />
            </>
          }
        />
      )}
      <div
        className={styles.editorCol}
        // A floating drawer covers the editor; reaching past it closes it.
        onMouseDown={() => {
          if (floating && drawer) setDrawer(null);
        }}
      >
        {diff?.deleted && diffSource ? (
          <DeletedDiff
            path={diff.path}
            source={diffSource}
            onClose={() => closeDeleted(diff.returnTo)}
          />
        ) : filePath && workspace ? (
          <OpenFile
            key={`${workspace.hostId}\0${workspace.path}\0${filePath}`}
            paneId={paneId}
            workspace={workspace}
            path={filePath}
            readOnly={readOnly}
            diff={diff && diff.path === filePath ? diffSource : null}
            onOpenPlain={() => setDiff(null)}
          />
        ) : (
          <div className={styles.empty} data-testid="file-pane-empty">
            Pick a file from the tree
          </div>
        )}
        {workspace && diff && (diff.deleted || diff.path === filePath) && (
          <div className={styles.reviewFloat}>
            <ReviewBar
              workspacePath={workspace.path}
              hostId={hostId}
              onJumpToComment={jumpToComment}
              testIds={{ bar: "review-float-bar", list: "review-float-list", send: "review-float-send" }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** The open file's path; `children` sit at the row's right end (the diff's tag and controls). */
function Breadcrumb({ path, children }: { path: string; children?: ReactNode }) {
  const parts = path.split("/");
  return (
    <div className={styles.crumbs}>
      <div className={styles.crumbPath} data-testid="file-pane-breadcrumb" title={path}>
        {parts.map((part, i) => (
          <span key={i} className={styles.crumbPart}>
            {i > 0 && <span className={styles.crumbSep}>/</span>}
            <span className={i === parts.length - 1 ? styles.crumbLast : styles.crumb}>
              {part}
            </span>
          </span>
        ))}
      </div>
      {children}
    </div>
  );
}

/** "Diff vs HEAD" (or the branch), and a note when the diff can't be shown as it stands. */
function DiffTag({ source, note }: { source: DiffSource; note: DiffNote | null }) {
  return (
    <>
      <span className={styles.diffTag} data-testid="file-pane-diff-tag">
        Diff vs {source.against}
      </span>
      {note && (
        <span
          className={`${styles.diffNote} ${note.kind === "stale" ? styles.diffNoteLate : ""}`}
          data-testid={note.kind === "stale" ? "file-pane-diff-stale" : "file-pane-diff-note"}
          role="status"
        >
          {note.text}
        </span>
      )}
    </>
  );
}

type DiffNote = { kind: "stale" | "info"; text: string };

/** Why a shown diff has no lines to show as it stands, or null when it does. */
function diffNote(
  source: DiffSource,
  binary: boolean,
  stale: boolean,
): DiffNote | null {
  if (source.error !== null) return { kind: "info", text: `Couldn't read the diff: ${source.error}` };
  if (binary) return { kind: "info", text: "Binary file: no lines to compare" };
  if (stale) return { kind: "stale", text: "Diff is out of date, refreshing…" };
  return null;
}

/** A deleted file's diff: its old side, all removed, read-only, and Close diff to leave it. */
function DeletedDiff({
  path,
  source,
  onClose,
}: {
  path: string;
  source: DiffSource;
  onClose: () => void;
}) {
  const raw = source.raw;
  const fileDiff = useMemo(() => (raw === undefined ? undefined : fileDiffIn(raw, path)), [raw, path]);
  const base = fileDiff?.deleted ? baseFromDiff("", fileDiff) : null;
  const note = diffNote(source, fileDiff?.binary ?? false, false);
  return (
    <div className={styles.openFile}>
      <Breadcrumb path={path}>
        <DiffTag source={source} note={note} />
        <Button
          size="sm"
          className={styles.openPlain}
          data-testid="file-pane-close-diff"
          onClick={onClose}
        >
          Close diff
        </Button>
      </Breadcrumb>
      <div className={styles.editorStack}>
        {fileDiff === undefined ? (
          <div className={styles.empty} />
        ) : base === null || fileDiff?.binary ? (
          <div className={styles.empty} data-testid="file-pane-diff-empty">
            {fileDiff?.binary ? "Binary file deleted" : "No longer deleted"}
          </div>
        ) : (
          <Suspense fallback={<div className={styles.empty} />}>
            <DeletedFileView path={path} base={base} />
          </Suspense>
        )}
      </div>
    </div>
  );
}

/** ⌘S on macOS, Ctrl+S elsewhere. */
function isSaveKey(e: React.KeyboardEvent): boolean {
  const mod = getPlatform() === "mac" ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s";
}

/**
 * Who changed the open file on disk, for the conflict banner: the agent whose
 * hooks last wrote it. Null when none did; the banner then says "An agent".
 */
function useFileAuthor(workspace: FilesWorkspace, path: string): string | null {
  const changes = useWorkspaceChanges(workspace);
  return useAgentLabel(changes?.authors[path] ?? null);
}

/** The gutter's marks for one file's change, or none for an unchanged or deleted file. */
function agentMarksFor(change: FileChange | undefined): AgentMarks | null {
  if (!change || change.status === "deleted") return null;
  return { kind: change.status === "added" ? "added" : "changed", ranges: change.ranges };
}

type OpenFileActions = {
  save: () => Promise<boolean>;
  reloadTheirs: () => void;
  retryRead: () => void;
  compare: () => void;
};

/** Disk vs. your copy, as Compare found them; or why the disk could not be read. */
type Comparison = { theirs: string; mine: string } | { message: string } | null;

/**
 * One open file: read it, then watch it. A change on disk reloads it while it
 * is clean and raises the conflict banner while it has unsaved edits. ⌘S
 * saves through `files.write`, expecting the hash it last read or wrote.
 * Mounted keyed by the file, so switching files is a fresh mount and closing
 * the pane unwatches it.
 */
function OpenFile({
  paneId,
  workspace,
  path,
  readOnly,
  diff,
  onOpenPlain,
}: {
  paneId: string;
  workspace: FilesWorkspace;
  path: string;
  readOnly: boolean;
  /** Show the file as its diff, read from this; null for the plain file. */
  diff: DiffSource | null;
  /** The diff's Open file: the plain editor, same file. */
  onOpenPlain: () => void;
}) {
  const stored = useOpenFileStore((s) => s.byPane[paneId]);
  // Until this mount has opened `path`, the pane may still hold the last file.
  const state =
    stored?.path === path && sameWorkspace(stored.workspace, workspace) ? stored : null;
  const setPaneFilePath = useAppStore((s) => s.setPaneFilePath);
  const author = useFileAuthor(workspace, path);
  const editorRef = useRef<CodeEditorRef>(null);
  // The editor follows the workspace diff for this file's gutter marks.
  const [agentMarks] = useState<AgentMarksSource>(() => ({
    follow: (onChange) =>
      followWorkspaceChanges(workspace, (changes) =>
        onChange(agentMarksFor(changes.files.get(path))),
      ),
  }));
  const actions = useRef<OpenFileActions | null>(null);
  const [comparison, setComparison] = useState<Comparison>(null);

  // The diff's old side, rebuilt only when the diff or the file on disk
  // changes, never per keystroke: the editor diffs your typing itself.
  const diffRaw = diff?.raw;
  const fileDiff = useMemo(
    () => (diffRaw === undefined ? undefined : fileDiffIn(diffRaw, path)),
    [diffRaw, path],
  );
  const [held, setHeld] = useState<(HeldBase & { view: ScmView }) | null>(null);
  let shownBase = held;
  const working = state && state.status === "ready" ? state.base : null;
  if (
    diff &&
    working !== null &&
    (held?.view !== diff.view || held.diff !== fileDiff || held.working !== working)
  ) {
    shownBase = {
      ...followDiffBase(held?.view === diff.view ? held : null, fileDiff, working),
      view: diff.view,
    };
    setHeld(shownBase);
  }
  const binary = fileDiff?.binary ?? false;
  const diffBase = diff && !binary && shownBase?.view === diff.view ? shownBase.base : null;
  // A conflict's banner already says the disk moved; the diff waits quietly under it.
  const note = diff
    ? diffNote(diff, binary, (shownBase?.stale ?? false) && !state?.conflict)
    : null;

  useMountEffect(() => {
    let live = true;
    const files = window.electronAPI.files;
    const store = useOpenFileStore.getState;
    const dispatch = (event: OpenFileEvent) => store().dispatch(paneId, event);
    const current = (): OpenFileState | null => {
      const s = store().byPane[paneId];
      return s?.path === path && sameWorkspace(s.workspace, workspace) ? s : null;
    };
    store().open(paneId, workspace, path);

    // A clean reload, Reload theirs or Discard: the editor shows the clean
    // copy at once, so it never holds edits the store has dropped.
    const stopFollowing = useOpenFileStore.subscribe((next, prev) => {
      const a = next.byPane[paneId];
      const b = prev.byPane[paneId];
      if (
        a?.path === path &&
        sameWorkspace(a.workspace, workspace) &&
        b &&
        a.baseVersion !== b.baseVersion
      ) {
        editorRef.current?.replaceContent(a.base);
      }
    });

    // Changes can come faster than reads answer; only the newest read counts.
    const reads = createLatestOnly();
    const read = async (reason: "open" | "changed" | "reload") => {
      const ticket = reads.begin();
      try {
        const result = await files.read(workspace, path);
        if (!live || !reads.isLatest(ticket)) return;
        if (result.ok) {
          dispatch({ type: "read", content: result.content, hash: result.hash, reason });
        } else {
          dispatch({ type: "read-failed", message: result.message, reason: result.reason });
        }
      } catch (err) {
        if (live && reads.isLatest(ticket)) {
          dispatch({ type: "read-failed", message: ipcErrorMessage(err) });
        }
      }
    };

    const onDiskChange = (hash: string | null) => {
      const s = current();
      if (!s) return;
      switch (diskChangeAction(s, hash)) {
        case "ignore":
          return;
        case "after-save":
          // The save, wherever it was started, judges it once it answers.
          noteDiskChangeDuringSave(paneId, hash);
          return;
        case "gone":
          dispatch({ type: "gone" });
          return;
        case "read":
          void read("changed");
      }
    };

    // The store does the write, so its answer lands even if this mount is
    // gone by then; this mount only lends it the editor.
    const stopEditor = registerOpenFileEditor(paneId, {
      workspace,
      path,
      content: () => editorRef.current?.content() ?? null,
      markClean: (written) => editorRef.current?.markClean(written) ?? false,
      diskChanged: (hash) => {
        if (live) onDiskChange(hash);
      },
    });

    const save = async (): Promise<boolean> => {
      if (readOnly || !editorRef.current) return false;
      return saveOpenFile(paneId);
    };

    actions.current = {
      save,
      reloadTheirs: () => void read("reload"),
      retryRead: () => void read("changed"),
      compare: () => {
        const mine = editorRef.current?.content() ?? "";
        setComparison(null);
        dispatch({ type: "compare", on: true });
        files.read(workspace, path).then(
          (result) => {
            if (!live) return;
            setComparison(
              result.ok ? { theirs: result.content, mine } : { message: result.message },
            );
          },
          (err) => {
            if (live) setComparison({ message: ipcErrorMessage(err) });
          },
        );
      },
    };

    const stopListening = files.onChanged((event) => {
      if (
        event.path !== path ||
        event.workspace.path !== workspace.path ||
        event.workspace.hostId !== workspace.hostId
      ) {
        return;
      }
      onDiskChange(event.hash);
    });
    // Read first, then watch: a change between the two is not reported.
    void read("open").then(() => {
      if (live) openFileWatches.set(workspace, paneId, path);
    });

    return () => {
      live = false;
      actions.current = null;
      stopEditor();
      stopListening();
      stopFollowing();
      openFileWatches.set(workspace, paneId, null);
    };
  });

  const dispatch = (event: OpenFileEvent) =>
    useOpenFileStore.getState().dispatch(paneId, event);

  if (!state || state.status === "loading") {
    return <div className={styles.empty} />;
  }
  if (state.status === "failed") {
    return (
      <>
        <Breadcrumb path={path} />
        <div className={styles.empty} data-testid="file-pane-error">
          {state.message}
        </div>
      </>
    );
  }

  const pendingOpen = state.pendingOpen;
  return (
    <div
      className={styles.openFile}
      onKeyDown={(e) => {
        if (readOnly || !isSaveKey(e)) return;
        e.preventDefault();
        e.stopPropagation();
        void actions.current?.save();
      }}
    >
      {pendingOpen !== null && (
        <div className={styles.confirm} data-testid="file-pane-swap-bar">
          <span className={styles.barMsg}>
            Unsaved changes to <b>{fileTitle(path)}</b>.
          </span>
          <Button
            size="sm"
            variant="primary"
            data-testid="file-pane-swap-save"
            disabled={state.saving}
            onClick={() => {
              void actions.current?.save().then((saved) => {
                if (saved) setPaneFilePath(paneId, pendingOpen);
              });
            }}
          >
            Save and open
          </Button>
          <Button
            size="sm"
            data-testid="file-pane-swap-discard"
            onClick={() => {
              dispatch({ type: "discard" });
              setPaneFilePath(paneId, pendingOpen);
            }}
          >
            Discard
          </Button>
          <Button
            size="sm"
            data-testid="file-pane-swap-cancel"
            onClick={() => dispatch({ type: "cancel-open" })}
          >
            Cancel
          </Button>
        </div>
      )}
      {state.conflict?.kind === "changed" && (
        <div className={styles.banner} data-testid="file-pane-conflict" role="alert">
          <span className={styles.barMsg}>
            <b className={styles.author}>{author ?? "An agent"}</b> changed this file on disk
            while you were editing.
          </span>
          <Button
            size="sm"
            data-testid="file-pane-conflict-compare"
            onClick={() => actions.current?.compare()}
          >
            Compare
          </Button>
          <Button
            size="sm"
            data-testid="file-pane-conflict-reload"
            onClick={() => actions.current?.reloadTheirs()}
          >
            Reload theirs
          </Button>
          <Button
            size="sm"
            variant="primary"
            data-testid="file-pane-conflict-keep"
            onClick={() => dispatch({ type: "keep-mine" })}
          >
            Keep mine
          </Button>
        </div>
      )}
      {state.conflict?.kind === "gone" && (
        <div className={styles.banner} data-testid="file-pane-conflict" role="alert">
          <span className={styles.barMsg}>
            This file was deleted or can't be opened anymore.
          </span>
          <Button
            size="sm"
            data-testid="file-pane-conflict-close"
            onClick={() => {
              dispatch({ type: "discard" });
              useAppStore.getState().closePaneById(paneId);
            }}
          >
            Close
          </Button>
          <Tooltip label="Saving writes your copy again">
            <Button
              size="sm"
              variant="primary"
              data-testid="file-pane-conflict-keep"
              onClick={() => dispatch({ type: "keep-mine" })}
            >
              Keep mine
            </Button>
          </Tooltip>
        </div>
      )}
      {state.readError !== null && (
        <div className={styles.banner} data-testid="file-pane-read-error" role="alert">
          <span className={styles.barMsg}>
            Couldn't re-read the file: {state.readError.replace(/\.$/, "")}.
          </span>
          <Button
            size="sm"
            data-testid="file-pane-read-retry"
            onClick={() => actions.current?.retryRead()}
          >
            Retry
          </Button>
        </div>
      )}
      {state.saveError !== null && (
        <div className={styles.saveError} data-testid="file-pane-save-error" role="alert">
          Couldn't save: {state.saveError}
        </div>
      )}
      <Breadcrumb path={path}>
        {diff && (
          <>
            <DiffTag source={diff} note={note} />
            <Button
              size="sm"
              className={styles.openPlain}
              data-testid="file-pane-open-plain"
              onClick={onOpenPlain}
            >
              Open file
            </Button>
          </>
        )}
      </Breadcrumb>
      <div className={styles.editorStack}>
        <Suspense fallback={<div className={styles.empty} />}>
          <CodeEditor
            ref={editorRef}
            paneId={paneId}
            path={path}
            base={state.base}
            draft={state.draft}
            readOnly={readOnly}
            onDirtyChange={(dirty) => dispatch({ type: "edited", dirty })}
            onDispose={(content, dirty) => {
              if (dirty) dispatch({ type: "stash-draft", draft: content });
            }}
            agentMarks={agentMarks}
            diffBase={diffBase}
            reviewWorkspace={workspace.path}
          />
        </Suspense>
        {state.comparing && (
          <div className={styles.compare} data-testid="file-pane-compare">
            <div className={styles.compareHead}>
              <span>On disk</span>
              <span className={styles.compareVs}>vs.</span>
              <span>Yours</span>
              <span className={styles.spacer} />
              <Button
                size="sm"
                data-testid="file-pane-compare-back"
                onClick={() => dispatch({ type: "compare", on: false })}
              >
                Back to editing
              </Button>
            </div>
            {comparison === null ? (
              <div className={styles.empty}>Loading…</div>
            ) : "message" in comparison ? (
              <div className={styles.empty}>{comparison.message}</div>
            ) : (
              <Suspense fallback={<div className={styles.empty} />}>
                <CompareView path={path} theirs={comparison.theirs} mine={comparison.mine} />
              </Suspense>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
