import { lazy, Suspense, useMemo, useRef, useState } from "react";
import Folder from "lucide-react/dist/esm/icons/folder";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import { useAppStore, usePaneFilePath, selectHasPane } from "../../../store/app-store";
import { useOpenFileStore, hasUnsavedEdits } from "../../../store/open-file-store";
import { LOCAL_HOST_ID } from "../../../lib/workspace-key";
import { getPlatform } from "../../../lib/keybindings";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { useLayoutMode } from "../../../hooks/useLayoutMode";
import { ipcErrorMessage } from "../../../lib/ipc-error";
import { fileTitle } from "../../../lib/pane-title";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import { Button } from "../../ui/Button/Button";
import type { CodeEditorRef } from "./CodeEditor/CodeEditor";
import { FileDrawer } from "./FileDrawer/FileDrawer";
import { openFileWatches, type FilesWorkspace } from "./open-file-watches";
import { createLatestOnly } from "./latest-only";
import { diskChangeAction, type OpenFileEvent, type OpenFileState } from "./open-file-state";
import styles from "./FilePane.module.css";

// CodeMirror is its own chunk: nothing loads it until a file pane opens a file.
const CodeEditor = lazy(() =>
  import("./CodeEditor/CodeEditor").then((m) => ({ default: m.CodeEditor })),
);

type FilePaneProps = {
  paneId: string;
  workspacePath?: string;
  hostId?: string;
};

type Drawer = "files" | null;

/**
 * A file pane: one file of its workspace, with a strip on its left edge whose
 * Files button opens the workspace's tree in a drawer over the editor. The
 * open file lives on the pane's leaf (`setPaneFilePath`), so it is the same
 * in every window and after a relaunch; its unsaved edits live in
 * `open-file-store`, so a remount keeps them. The phone shows it read-only.
 */
export function FilePane({ paneId, workspacePath, hostId }: FilePaneProps) {
  const filePath = usePaneFilePath(paneId);
  const setPaneFilePath = useAppStore((s) => s.setPaneFilePath);
  const readOnly = useLayoutMode() === "phone";
  // A pane with nothing open starts on its tree.
  const [drawer, setDrawer] = useState<Drawer>(() => (filePath ? null : "files"));
  const workspace = useMemo<FilesWorkspace | null>(
    () =>
      workspacePath ? { path: workspacePath, hostId: hostId ?? LOCAL_HOST_ID } : null,
    [workspacePath, hostId],
  );

  // A split rebuilds the pane, so its edits outlive the mount; a closed pane's go.
  useMountEffect(() => () => {
    if (!selectHasPane(useAppStore.getState(), paneId)) {
      useOpenFileStore.getState().drop(paneId);
    }
  });

  const pick = (path: string) => {
    setDrawer(null);
    if (path === filePath) return;
    // Unsaved edits ask first, in the swap bar.
    if (hasUnsavedEdits(paneId)) {
      useOpenFileStore.getState().dispatch(paneId, { type: "ask-before-open", path });
      return;
    }
    setPaneFilePath(paneId, path);
  };

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
            className={styles.stripBtn}
            aria-label="Changed by agents"
            data-testid="file-pane-changes-button"
            disabled
          >
            <GitBranch size={14} />
          </button>
        </Tooltip>
      </div>
      <div
        className={styles.editorCol}
        // The drawer floats over the editor; reaching past it closes it.
        onMouseDown={() => {
          if (drawer) setDrawer(null);
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
      {drawer === "files" && workspace && (
        <FileDrawer
          workspace={workspace}
          openFile={filePath}
          canCreate={!readOnly}
          onPick={pick}
          onClose={() => setDrawer(null)}
        />
      )}
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

type OpenFileActions = {
  save: () => Promise<boolean>;
};

/**
 * One open file: read it, then watch it. A change on disk reloads it while it
 * is clean; unsaved edits stay. ⌘S saves through `files.write`, expecting the
 * hash it last read or wrote.
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
  const state = stored?.path === path ? stored : null;
  const setPaneFilePath = useAppStore((s) => s.setPaneFilePath);
  const editorRef = useRef<CodeEditorRef>(null);
  const actions = useRef<OpenFileActions | null>(null);

  useMountEffect(() => {
    let live = true;
    const files = window.electronAPI.files;
    const store = useOpenFileStore.getState;
    const dispatch = (event: OpenFileEvent) => store().dispatch(paneId, event);
    const current = (): OpenFileState | null => {
      const s = store().byPane[paneId];
      return s?.path === path ? s : null;
    };
    store().open(paneId, path);

    // A clean reload: the editor shows the new clean copy.
    const stopFollowing = useOpenFileStore.subscribe((next, prev) => {
      const a = next.byPane[paneId];
      const b = prev.byPane[paneId];
      if (a?.path === path && b && a.baseVersion !== b.baseVersion) {
        editorRef.current?.replaceContent(a.base);
      }
    });

    // Changes can come faster than reads answer; only the newest read counts.
    const reads = createLatestOnly();
    const read = async (reason: "open" | "changed") => {
      const ticket = reads.begin();
      try {
        const result = await files.read(workspace, path);
        if (!live || !reads.isLatest(ticket)) return;
        if (result.ok) {
          dispatch({ type: "read", content: result.content, hash: result.hash, reason });
        } else {
          dispatch({ type: "read-failed", message: result.message });
        }
      } catch (err) {
        if (live && reads.isLatest(ticket)) {
          dispatch({ type: "read-failed", message: ipcErrorMessage(err) });
        }
      }
    };

    // A change reported mid-save waits until the save says what it wrote.
    let afterSave: { hash: string | null } | null = null;
    const onDiskChange = (hash: string | null) => {
      const s = current();
      if (!s) return;
      switch (diskChangeAction(s, hash)) {
        case "ignore":
          return;
        case "after-save":
          afterSave = { hash };
          return;
        case "read":
          void read("changed");
      }
    };

    const save = async (): Promise<boolean> => {
      const editor = editorRef.current;
      const s = current();
      if (readOnly || !editor || !s || s.status !== "ready" || s.saving) return false;
      const content = editor.content();
      dispatch({ type: "save-started" });
      let saved = false;
      try {
        const result = await files.write(workspace, path, content, s.expectedHash ?? undefined);
        if (!live) return false;
        if (result.ok) {
          const dirty = editorRef.current?.markClean(content) ?? false;
          dispatch({ type: "saved", content, hash: result.hash, dirty });
          saved = true;
        } else {
          dispatch({ type: "save-failed", message: result.message });
        }
      } catch (err) {
        if (!live) return false;
        dispatch({ type: "save-failed", message: ipcErrorMessage(err) });
      }
      const pending = afterSave;
      afterSave = null;
      if (pending) onDiskChange(pending.hash);
      return saved;
    };

    actions.current = { save };

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
          />
        </Suspense>
      </div>
    </div>
  );
}
