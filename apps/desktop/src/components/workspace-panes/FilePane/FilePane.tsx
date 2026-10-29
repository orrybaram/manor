import { lazy, Suspense, useMemo, useRef, useState } from "react";
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
import { LOCAL_HOST_ID } from "../../../lib/workspace-key";
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
import { followWorkspaceChanges, useWorkspaceChanges } from "./workspace-changes";
import { openFileWatches, type FilesWorkspace } from "./open-file-watches";
import { createLatestOnly } from "./latest-only";
import { pendingLines } from "./pending-line";
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
 * A file pane: one file of its workspace, with a strip on its left edge whose
 * Files button opens the workspace's tree in a drawer beside the editor, and
 * whose Changed by agents button opens the workspace's changed files. The
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
  }
  // The same file sent again only moves the cursor; it still wants the editor.
  useMountEffect(() =>
    pendingLines.subscribe(paneId, () => {
      if (floatingRef.current) setDrawer(null);
    }),
  );
  const workspace = useMemo<FilesWorkspace | null>(
    () =>
      workspacePath ? { path: workspacePath, hostId: hostId ?? LOCAL_HOST_ID } : null,
    [workspacePath, hostId],
  );
  const changes = useWorkspaceChanges(workspace);
  const openFileDirty = useOpenFileStore((s) => s.byPane[paneId]?.dirty ?? false);
  const changeCount = changes?.files.size ?? 0;

  // A split rebuilds the pane, so its edits outlive the mount; a closed
  // pane's go, and so do those of a pane that is no longer a file pane.
  useMountEffect(() => () => {
    const app = useAppStore.getState();
    if (!selectHasPane(app, paneId) || selectPaneContentType(app, paneId) !== "file") {
      useOpenFileStore.getState().drop(paneId);
    }
  });

  const pick = (path: string) => {
    if (floating) setDrawer(null);
    if (path === filePath) return;
    // Unsaved edits ask first, in the swap bar.
    if (hasUnsavedEdits(paneId)) {
      useOpenFileStore.getState().dispatch(paneId, { type: "ask-before-open", path });
      return;
    }
    setPaneFilePath(paneId, path);
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
        <Tooltip label="Changed by agents">
          <button
            type="button"
            className={`${styles.stripBtn} ${drawer === "changes" ? styles.stripBtnOn : ""}`}
            aria-label={`Changed by agents${changeCount > 0 ? ` (${changeCount})` : ""}`}
            aria-pressed={drawer === "changes"}
            data-testid="file-pane-changes-button"
            disabled={!workspace}
            onClick={() => setDrawer((d) => (d === "changes" ? null : "changes"))}
          >
            <GitBranch size={14} />
            {changeCount > 0 && (
              <span className={styles.count} data-testid="file-pane-changes-count">
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
          canWrite={!readOnly}
          openFileDirty={openFileDirty}
          onPick={pick}
          onRenamed={(from, to) => {
            if (from === filePath) setPaneFilePath(paneId, to);
          }}
          onClose={() => setDrawer(null)}
          resizeHandle={floating ? undefined : openHandle}
        />
      )}
      <div
        className={styles.editorCol}
        // A floating drawer covers the editor; reaching past it closes it.
        onMouseDown={() => {
          if (floating && drawer) setDrawer(null);
        }}
      >
        {filePath && workspace ? (
          <OpenFile
            key={`${workspace.hostId}\0${workspace.path}\0${filePath}`}
            paneId={paneId}
            workspace={workspace}
            path={filePath}
            readOnly={readOnly}
          />
        ) : (
          <div className={styles.empty} data-testid="file-pane-empty">
            Pick a file from the tree
          </div>
        )}
      </div>
    </div>
  );
}

function Breadcrumb({ path }: { path: string }) {
  const parts = path.split("/");
  return (
    <div className={styles.crumbs} data-testid="file-pane-breadcrumb" title={path}>
      {parts.map((part, i) => (
        <span key={i} className={styles.crumbPart}>
          {i > 0 && <span className={styles.crumbSep}>/</span>}
          <span className={i === parts.length - 1 ? styles.crumbLast : styles.crumb}>
            {part}
          </span>
        </span>
      ))}
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
}: {
  paneId: string;
  workspace: FilesWorkspace;
  path: string;
  readOnly: boolean;
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
      <Breadcrumb path={path} />
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
