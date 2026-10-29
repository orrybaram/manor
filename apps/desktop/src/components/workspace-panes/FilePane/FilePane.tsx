import { lazy, Suspense, useMemo, useRef, useState } from "react";
import Folder from "lucide-react/dist/esm/icons/folder";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import { useAppStore, usePaneFilePath } from "../../../store/app-store";
import { LOCAL_HOST_ID } from "../../../lib/workspace-key";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { ipcErrorMessage } from "../../../lib/ipc-error";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import type { CodeEditorRef } from "./CodeEditor/CodeEditor";
import { FileDrawer } from "./FileDrawer/FileDrawer";
import { openFileWatches, type FilesWorkspace } from "./open-file-watches";
import { createLatestOnly } from "./latest-only";
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
 * A file pane: one file of its workspace, read-only for now, with a strip on
 * its left edge whose Files button opens the workspace's tree in a drawer
 * over the editor. The open file lives on the pane's leaf
 * (`setPaneFilePath`), so it is the same in every window and after a
 * relaunch.
 */
export function FilePane({ paneId, workspacePath, hostId }: FilePaneProps) {
  const filePath = usePaneFilePath(paneId);
  const setPaneFilePath = useAppStore((s) => s.setPaneFilePath);
  // A pane with nothing open starts on its tree.
  const [drawer, setDrawer] = useState<Drawer>(() => (filePath ? null : "files"));
  const workspace = useMemo<FilesWorkspace | null>(
    () =>
      workspacePath ? { path: workspacePath, hostId: hostId ?? LOCAL_HOST_ID } : null,
    [workspacePath, hostId],
  );

  const pick = (path: string) => {
    setPaneFilePath(paneId, path);
    setDrawer(null);
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
          <>
            <Breadcrumb path={filePath} />
            <OpenFile
              key={`${workspace.hostId}\0${workspace.path}\0${filePath}`}
              paneId={paneId}
              workspace={workspace}
              path={filePath}
            />
          </>
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

type OpenFileState =
  | { status: "loading" }
  | { status: "ready"; content: string }
  | { status: "failed"; message: string };

/**
 * One open file: read it, then watch it, and read it again when it changes on
 * disk. Mounted keyed by the file, so switching files is a fresh mount and
 * closing the pane unwatches it.
 */
function OpenFile({
  paneId,
  workspace,
  path,
}: {
  paneId: string;
  workspace: FilesWorkspace;
  path: string;
}) {
  const [state, setState] = useState<OpenFileState>({ status: "loading" });
  const editorRef = useRef<CodeEditorRef>(null);
  const hashRef = useRef<string | null>(null);

  useMountEffect(() => {
    let live = true;
    const files = window.electronAPI.files;
    // Changes can come faster than reads answer; only the newest read counts.
    const reads = createLatestOnly();

    const load = async () => {
      const ticket = reads.begin();
      try {
        const result = await files.read(workspace, path);
        if (!live || !reads.isLatest(ticket)) return;
        if (!result.ok) {
          hashRef.current = null;
          setState({ status: "failed", message: result.message });
          return;
        }
        hashRef.current = result.hash;
        // Read-only, so never dirty: a change on disk simply replaces it.
        if (editorRef.current) editorRef.current.replaceContent(result.content);
        else setState({ status: "ready", content: result.content });
      } catch (err) {
        if (live && reads.isLatest(ticket)) setState({ status: "failed", message: ipcErrorMessage(err) });
      }
    };

    const stopListening = files.onChanged((event) => {
      if (
        event.path !== path ||
        event.workspace.path !== workspace.path ||
        event.workspace.hostId !== workspace.hostId
      ) {
        return;
      }
      if (event.hash !== null && event.hash === hashRef.current) return;
      void load();
    });
    // Read first, then watch: a change between the two is not reported.
    void load().then(() => {
      if (live) openFileWatches.set(workspace, paneId, path);
    });

    return () => {
      live = false;
      stopListening();
      openFileWatches.set(workspace, paneId, null);
    };
  });

  if (state.status === "failed") {
    return (
      <div className={styles.empty} data-testid="file-pane-error">
        {state.message}
      </div>
    );
  }
  if (state.status === "loading") {
    return <div className={styles.empty} />;
  }
  return (
    <Suspense fallback={<div className={styles.empty} />}>
      <CodeEditor
        ref={editorRef}
        paneId={paneId}
        path={path}
        initialContent={state.content}
      />
    </Suspense>
  );
}
