import {
  createElement,
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import FileCode from "lucide-react/dist/esm/icons/file-code";
import Folder from "lucide-react/dist/esm/icons/folder";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open";
import Minus from "lucide-react/dist/esm/icons/minus";
import Plus from "lucide-react/dist/esm/icons/plus";
import Undo2 from "lucide-react/dist/esm/icons/undo-2";
import { useProjectStore } from "../../../../store/project-store";
import { ownerOf } from "../../../../lib/workspace-directory";
import { workspaceKey } from "../../../../lib/workspace-key";
import { isWebApp } from "../../../../lib/platform";
import { ConfirmDialog } from "../../../ui/ConfirmDialog/ConfirmDialog";
import { ToggleGroup } from "../../../ui/ToggleGroup";
import { Tooltip } from "../../../ui/Tooltip/Tooltip";
import { Collapse } from "../../../ui/Collapse/Collapse";
import { fileIconFor } from "../../FileTree/file-icon";
import {
  fetchDiffSingleFlight,
  fetchStagedSingleFlight,
} from "../../../../lib/diff/diff-fetch";
import { FingerprintedFetch } from "../FingerprintedFetch";
import { fileChangesFromDiff, type FileChange } from "../file-changes";
import type { FilesWorkspace } from "../open-file-watches";
import type { WorkspaceChanges } from "../workspace-changes";
import { CommitBox } from "./CommitBox";
import { runGitFileAction, type GitFileAction } from "./git-actions";
import {
  branchEntries,
  localGroups,
  scmTree,
  withStaged,
  type ScmEntry,
  type ScmNode,
  type ScmView,
} from "./scm-entries";
import styles from "./SourceControl.module.css";

const NO_GIT_FROM_BROWSER = "Git isn't available from the browser yet";
const NO_STAGED: ReadonlySet<string> = new Set();

/** Local (working changes) or Branch (vs. the default branch), in the drawer's head. */
export function ScmViewToggle({
  value,
  onChange,
}: {
  value: ScmView;
  onChange: (view: ScmView) => void;
}) {
  return (
    <ToggleGroup
      size="xs"
      value={value}
      onChange={onChange}
      aria-label="Source Control view"
      // Switching refetches: arrow keys only move focus.
      activationMode="manual"
      data-testid="scm-mode"
      options={[
        { value: "local", label: "Local" },
        { value: "branch", label: "Branch" },
      ]}
    />
  );
}

type SourceControlProps = {
  workspace: FilesWorkspace;
  view: ScmView;
  /** The workspace's working changes and who wrote them, as the file pane follows them; null until read. */
  changes: WorkspaceChanges | null;
  /** The pane's open file, workspace-relative: its row shows selected. */
  openFile: string | null;
  /** A row was clicked: show that change. */
  onOpenChange: (change: FileChange, view: ScmView) => void;
  /** A row's Open file: the plain file in the editor. */
  onOpenFile: (path: string) => void;
};

/**
 * Source Control, the file pane drawer's second mode. Local: a commit box,
 * then the working changes in Staged and Changes, with stage, unstage and discard per file
 * and per group. Branch: everything changed since the project's default
 * branch, to read only. Both are fetched as the file pane fetches its own
 * (single-flight, again only when the workspace's diff fingerprint moves),
 * through the bridge, so a workspace on a remote host works the same.
 */
export function SourceControl({
  workspace,
  view,
  changes,
  openFile,
  onOpenChange,
  onOpenFile,
}: SourceControlProps) {
  const wsKey = workspaceKey(workspace.hostId, workspace.path);
  const defaultBranch =
    useProjectStore((s) => ownerOf(s.projects, wsKey)?.defaultBranch) ?? "main";
  const webApp = isWebApp();

  // Each result is tagged with what it was fetched for, so a stale one reads as absent.
  const [stagedResult, setStagedResult] = useState<{
    key: string;
    files: ReadonlySet<string>;
  } | null>(null);
  const staged = stagedResult?.key === wsKey ? stagedResult.files : NO_STAGED;
  const branchKey = `${wsKey}\u0000branch\u0000${defaultBranch}`;
  const [branchResult, setBranchResult] = useState<{
    key: string;
    raw: string | null;
    error: string | null;
  } | null>(null);
  const branch = branchResult?.key === branchKey ? branchResult : null;

  const [busy, setBusy] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [discarding, setDiscarding] = useState<{
    path: string;
    /** Untracked: discarding deletes the file outright. */
    untracked: boolean;
  } | null>(null);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());

  const updateStaged = (files: string[], on: boolean) =>
    setStagedResult((prev) => ({
      key: wsKey,
      files: withStaged(
        prev?.key === wsKey ? prev.files : NO_STAGED,
        files,
        on,
      ),
    }));

  const act = async (action: GitFileAction, files: string[]) => {
    if (webApp || busy || committing || files.length === 0) return;
    // Stage and unstage move the rows at once; a refusal moves them back.
    if (action !== "discard") updateStaged(files, action === "stage");
    setBusy(true);
    const ok = await runGitFileAction(action, workspace.path, files);
    if (!ok && action !== "discard") updateStaged(files, action !== "stage");
    setBusy(false);
  };

  const toggleGroup = (id: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const local = useMemo(
    () => (changes ? localGroups(changes.files.values(), staged) : null),
    [changes, staged],
  );
  // Parsed only when the raw diff changes, not on every re-fetch that finds it the same.
  const branchRaw = branch?.raw ?? null;
  const onBranch = useMemo(
    () => branchEntries(fileChangesFromDiff(branchRaw).values()),
    [branchRaw],
  );

  // Rows get one callback that never changes, reading this render's state
  // through a ref, so a memoized row re-renders only when what it shows does.
  const onRowRef = useRef<(action: RowAction, entry: ScmEntry) => void>(
    () => {},
  );
  onRowRef.current = (action, rowEntry) => {
    const path = rowEntry.change.path;
    // A memoized row may hold an older copy of its entry (same path and
    // letter, older ranges): act on this render's.
    const listed =
      view === "local"
        ? [...(local?.staged ?? []), ...(local?.changes ?? [])]
        : onBranch;
    const entry = listed.find((e) => e.change.path === path) ?? rowEntry;
    if (action === "open") onOpenChange(entry.change, view);
    else if (action === "openFile") onOpenFile(path);
    else if (action === "discard")
      setDiscarding({ path, untracked: entry.letter === "U" });
    else void act(action, [path]);
  };
  const onRow = useCallback(
    (action: RowAction, entry: ScmEntry) => onRowRef.current(action, entry),
    [],
  );
  const locked = webApp || busy || committing;

  const gitButton = (
    label: string,
    testId: string,
    icon: ReactNode,
    onClick: () => void,
  ) => (
    <GitButton
      label={label}
      testId={testId}
      icon={icon}
      webApp={webApp}
      locked={locked}
      onClick={onClick}
    />
  );

  // A group's files as a folder tree; a folder's open state is kept per group.
  const rows = (nodes: ScmNode[], group: RowGroup, depth = 0): ReactNode[] =>
    nodes.flatMap((node) => {
      if (node.kind === "file") {
        const { entry } = node;
        return [
          <ScmRow
            key={entry.change.path}
            entry={entry}
            group={group}
            depth={depth}
            selected={entry.change.path === openFile}
            webApp={webApp}
            locked={locked}
            onRow={onRow}
          />,
        ];
      }
      const id = `${group}\u0000${node.path}`;
      const open = !closed.has(id);
      return [
        <ScmDirRow
          key={`dir\u0000${node.path}`}
          name={node.name}
          path={node.path}
          depth={depth}
          open={open}
          onToggle={() => toggleGroup(id)}
        />,
        ...(open ? rows(node.children, group, depth + 1) : []),
      ];
    });

  const group = (
    id: string,
    label: string,
    entries: ScmEntry[],
    actions?: ReactNode,
    testId = `scm-group-${id}`,
  ) => {
    const open = !closed.has(id);
    const Chevron = open ? ChevronDown : ChevronRight;
    return (
      <div className={styles.group} data-testid={testId}>
        <div className={styles.groupHead}>
          <button
            type="button"
            className={styles.groupToggle}
            aria-expanded={open}
            onClick={() => toggleGroup(id)}
          >
            <Chevron size={12} className={styles.chevron} />
            <span className={styles.groupLabel}>{label}</span>
            <span className={styles.groupCount} data-testid="scm-group-count">
              {entries.length}
            </span>
          </button>
          {actions && <span className={styles.actions}>{actions}</span>}
        </div>
        <Collapse open={open}>
          {rows(scmTree(entries), id as RowGroup)}
        </Collapse>
      </div>
    );
  };

  let body: ReactNode;
  if (view === "local") {
    if (!local) body = <Note>Loading…</Note>;
    else if (local.staged.length === 0 && local.changes.length === 0)
      body = <Note testId="scm-empty">No changes</Note>;
    else
      body = (
        <>
          {local.staged.length > 0 &&
            group(
              "staged",
              "Staged",
              local.staged,
              gitButton(
                "Unstage all",
                "scm-unstage-all",
                <Minus size={13} />,
                () =>
                  void act(
                    "unstage",
                    local.staged.map((e) => e.change.path),
                  ),
              ),
            )}
          {local.changes.length > 0 &&
            group(
              "changes",
              "Changes",
              local.changes,
              gitButton(
                "Stage all",
                "scm-stage-all",
                <Plus size={13} />,
                () =>
                  void act(
                    "stage",
                    local.changes.map((e) => e.change.path),
                  ),
              ),
            )}
        </>
      );
  } else if (!branch) {
    body = <Note>Loading…</Note>;
  } else if (branch.error !== null) {
    body = <Note>{branch.error}</Note>;
  } else if (onBranch.length === 0) {
    body = <Note testId="scm-empty">No changes vs {defaultBranch}</Note>;
  } else {
    body = group("branch", `Changes vs ${defaultBranch}`, onBranch);
  }

  return (
    <div className={styles.list} data-testid="scm" data-view={view}>
      {view === "local" ? (
        <FingerprintedFetch
          key={`staged\u0000${wsKey}`}
          wsKey={wsKey}
          fetch={() =>
            fetchStagedSingleFlight(wsKey, () =>
              window.electronAPI.diffs.getStagedFiles(workspace.path),
            )
          }
          // A re-fetch that finds the same files keeps the set, and so every row.
          onResult={(files) =>
            setStagedResult((prev) =>
              prev?.key === wsKey && sameFiles(prev.files, files)
                ? prev
                : { key: wsKey, files: new Set(files) },
            )
          }
        />
      ) : (
        <FingerprintedFetch
          key={branchKey}
          wsKey={wsKey}
          // The file pane's Branch fetch, under the same key: one `git diff` for both.
          fetch={() =>
            fetchDiffSingleFlight(branchKey, () =>
              window.electronAPI.diffs.getFullDiff(
                workspace.path,
                defaultBranch,
              ),
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
      {view === "local" && (
        <CommitBox
          // A workspace's draft and options never carry into another's.
          key={wsKey}
          wsKey={wsKey}
          workspacePath={workspace.path}
          stagedCount={local?.staged.length ?? 0}
          disabledReason={webApp ? NO_GIT_FROM_BROWSER : null}
          busy={busy}
          onCommittingChange={setCommitting}
        />
      )}
      {body}
      {/* Its Escape closes only the dialog: React bubbles it, through the
          portal, to the drawer, which would close on it too. */}
      <div
        className={styles.dialogHost}
        onKeyDown={(e) => {
          if (e.key === "Escape") e.stopPropagation();
        }}
      >
        <ConfirmDialog
          open={discarding !== null}
          // An untracked file has nothing to go back to: discarding it is `git clean`.
          title={
            discarding?.untracked
              ? `Delete ${basename(discarding.path)}?`
              : "Discard changes?"
          }
          description={
            discarding?.untracked
              ? `${basename(discarding.path)} is new and not tracked by git; discarding deletes it. This can't be undone.`
              : `Your changes to ${discarding?.path ?? ""} will be lost. This can't be undone.`
          }
          confirmLabel={discarding?.untracked ? "Delete" : "Discard"}
          confirmVariant="danger"
          onCancel={() => setDiscarding(null)}
          onConfirm={() => {
            const path = discarding?.path;
            setDiscarding(null);
            if (path) void act("discard", [path]);
          }}
        />
      </div>
    </div>
  );
}

function Note({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className={styles.note} data-testid={testId ?? "scm-status"}>
      {children}
    </div>
  );
}

type RowGroup = "staged" | "changes" | "branch";

/** Left padding for a tree row `depth` folders deep; a file's icon sits where a folder's chevron would. */
const rowIndent = (depth: number, file: boolean) =>
  6 + depth * 12 + (file ? 16 : 0);

/** A folder in the tree: click to fold or unfold what's under it. */
function ScmDirRow({
  name,
  path,
  depth,
  open,
  onToggle,
}: {
  name: string;
  path: string;
  depth: number;
  open: boolean;
  onToggle: () => void;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  const Icon = open ? FolderOpen : Folder;
  return (
    <div className={styles.row} data-testid="scm-dir" data-path={path}>
      <button
        type="button"
        className={styles.rowMain}
        style={{ paddingLeft: rowIndent(depth, false), gap: 4 }}
        title={path}
        aria-expanded={open}
        onClick={onToggle}
      >
        <Chevron size={12} className={styles.chevron} />
        <Icon size={12} className={styles.fileIcon} />
        <span className={styles.dirName}>{name}</span>
      </button>
    </div>
  );
}
type RowAction = "open" | "openFile" | GitFileAction;

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function sameFiles(
  had: ReadonlySet<string>,
  files: readonly string[],
): boolean {
  return had.size === files.length && files.every((f) => had.has(f));
}

/** A git action's icon button: disabled, with the reason, in the web app or while one runs. */
function GitButton({
  label,
  testId,
  icon,
  webApp,
  locked,
  destructive = false,
  onClick,
}: {
  label: string;
  testId: string;
  icon: ReactNode;
  webApp: boolean;
  locked: boolean;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip label={webApp ? NO_GIT_FROM_BROWSER : label}>
      <button
        type="button"
        className={`${styles.iconBtn} ${destructive ? styles.iconBtnDanger : ""}`}
        aria-label={label}
        // aria-disabled keeps the reason's tooltip reachable on hover.
        aria-disabled={locked ? true : undefined}
        data-testid={testId}
        onClick={(e) => {
          e.stopPropagation();
          if (!locked) onClick();
        }}
      >
        {icon}
      </button>
    </Tooltip>
  );
}

type ScmRowProps = {
  entry: ScmEntry;
  group: RowGroup;
  /** How many folders deep it sits in the tree. */
  depth: number;
  selected: boolean;
  webApp: boolean;
  /** A git action is running, or git can't be reached: its buttons wait. */
  locked: boolean;
  onRow: (action: RowAction, entry: ScmEntry) => void;
};

/**
 * Entries are rebuilt whenever the list is, so a row compares what it
 * shows rather than the objects it was given.
 */
function sameRow(a: ScmRowProps, b: ScmRowProps): boolean {
  return (
    a.entry.change.path === b.entry.change.path &&
    a.entry.change.status === b.entry.change.status &&
    a.entry.letter === b.entry.letter &&
    a.group === b.group &&
    a.depth === b.depth &&
    a.selected === b.selected &&
    a.webApp === b.webApp &&
    a.locked === b.locked &&
    a.onRow === b.onRow
  );
}

/** One changed file: icon, name, then actions and letter. */
const ScmRow = memo(function ScmRow({
  entry,
  group,
  depth,
  selected,
  webApp,
  locked,
  onRow,
}: ScmRowProps) {
  const { change, letter } = entry;
  const name = basename(change.path);
  const gitButton = (
    action: GitFileAction,
    label: string,
    testId: string,
    icon: ReactNode,
  ) => (
    <GitButton
      label={label}
      testId={testId}
      icon={icon}
      webApp={webApp}
      locked={locked}
      destructive={action === "discard"}
      onClick={() => onRow(action, entry)}
    />
  );
  return (
    <div
      className={`${styles.row} ${selected ? styles.rowSelected : ""} ${styles[`letter_${letter}`]}`}
      data-testid="scm-row"
      data-path={change.path}
      data-letter={letter}
    >
      <button
        type="button"
        className={styles.rowMain}
        style={{ paddingLeft: rowIndent(depth, true) }}
        title={
          change.status === "deleted" ? `${change.path} (deleted)` : change.path
        }
        aria-current={selected ? "true" : undefined}
        onClick={() => onRow("open", entry)}
      >
        {createElement(fileIconFor(change.path), {
          size: 12,
          className: styles.fileIcon,
        })}
        <span className={styles.name}>{name}</span>
      </button>
      <span className={styles.actions}>
        {change.status !== "deleted" && (
          <Tooltip label="Open file">
            <button
              type="button"
              className={styles.iconBtn}
              aria-label="Open file"
              data-testid="scm-open"
              onClick={(e) => {
                e.stopPropagation();
                onRow("openFile", entry);
              }}
            >
              <FileCode size={13} />
            </button>
          </Tooltip>
        )}
        {group === "changes" &&
          gitButton(
            "discard",
            letter === "U" ? "Delete file" : "Discard changes",
            "scm-discard",
            <Undo2 size={13} />,
          )}
        {group === "changes" &&
          gitButton("stage", "Stage", "scm-stage", <Plus size={13} />)}
        {group === "staged" &&
          gitButton("unstage", "Unstage", "scm-unstage", <Minus size={13} />)}
      </span>
      <span className={styles.letter} data-testid="scm-letter">
        {letter}
      </span>
    </div>
  );
}, sameRow);
