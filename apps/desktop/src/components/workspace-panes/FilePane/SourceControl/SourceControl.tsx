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
import { getPlatform } from "../../../../lib/keybindings";
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
import {
  actionTargets,
  NO_SELECTION,
  selectedIn,
  selectGesture,
  selectRow,
  type ScmSelection,
} from "./scm-selection";
import styles from "./SourceControl.module.css";

const NO_GIT_FROM_BROWSER = "Git isn't available from the browser yet";
const NO_STAGED: ReadonlySet<string> = new Set();

/** Uncommitted (working changes) or vs main (everything since the default branch), in the drawer's head. */
export function ScmViewToggle({
  value,
  onChange,
  defaultBranch,
}: {
  value: ScmView;
  onChange: (view: ScmView) => void;
  defaultBranch: string;
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
        { value: "local", label: "Uncommitted" },
        { value: "branch", label: `vs ${defaultBranch}` },
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
 * Source Control, the file pane drawer's second mode. Uncommitted: a commit box,
 * then the working changes in Staged and Changes, with stage, unstage and discard per file
 * and per group. vs main: everything changed since the project's default
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
  const mac = getPlatform() === "mac";

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
    paths: string[];
    /** The untracked ones: discarding deletes them outright. */
    untracked: ReadonlySet<string>;
  } | null>(null);
  // Per workspace and view, as the fetched results are: another's is absent.
  const selectionKey = `${wsKey}\u0000${view}`;
  const [selectionResult, setSelectionResult] = useState<{
    key: string;
    selection: ScmSelection<RowGroup>;
  } | null>(null);
  const selection =
    selectionResult?.key === selectionKey
      ? selectionResult.selection
      : NO_SELECTION;
  const setSelection = (next: ScmSelection<RowGroup>) =>
    setSelectionResult({ key: selectionKey, selection: next });
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

  const act = async (
    action: GitFileAction,
    files: string[],
    untracked?: ReadonlySet<string>,
  ) => {
    if (webApp || busy || committing || files.length === 0) return;
    // The selected rows are acted on, and move or go: the selection is done.
    setSelection(NO_SELECTION);
    // Stage and unstage move the rows at once; a refusal moves them back.
    if (action !== "discard") updateStaged(files, action === "stage");
    setBusy(true);
    const ok = await runGitFileAction(
      action,
      workspace.path,
      files,
      untracked,
    );
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

  const groupEntries = (group: RowGroup): ScmEntry[] =>
    group === "staged"
      ? (local?.staged ?? [])
      : group === "changes"
        ? (local?.changes ?? [])
        : onBranch;
  const selectedOf = (group: RowGroup) =>
    selectedIn(
      selection,
      group,
      groupEntries(group).map((e) => e.change.path),
    );
  // Each group's file rows in the order they show, folders' closed ones left
  // out: what a Shift+click ranges over. Filled as this render lists them.
  const visible: Record<RowGroup, string[]> = {
    staged: [],
    changes: [],
    branch: [],
  };

  // Rows get one callback that never changes, reading this render's state
  // through a ref, so a memoized row re-renders only when what it shows does.
  const onRowRef = useRef<OnRow>(() => {});
  onRowRef.current = (action, rowEntry, group, click) => {
    const path = rowEntry.change.path;
    // A memoized row may hold an older copy of its entry (same path and
    // letter, older ranges): act on this render's.
    const listed = groupEntries(group);
    const entry = listed.find((e) => e.change.path === path) ?? rowEntry;
    if (action === "open") {
      const gesture = click ? selectGesture(click, mac) : "only";
      setSelection(selectRow(selection, group, path, gesture, visible[group]));
      // Shift and Cmd+click only select; a plain click shows the change.
      if (gesture === "only") onOpenChange(entry.change, view);
      return;
    }
    if (action === "openFile") {
      onOpenFile(path);
      return;
    }
    const files = actionTargets(selectedOf(group), path);
    if (action === "discard") {
      const untracked = new Set(
        listed
          .filter((e) => e.letter === "U" && files.includes(e.change.path))
          .map((e) => e.change.path),
      );
      setDiscarding({ paths: files, untracked });
    } else void act(action, files);
  };
  const onRow = useCallback<OnRow>(
    (action, entry, group, click) =>
      onRowRef.current(action, entry, group, click),
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
  const rows = (
    nodes: ScmNode[],
    group: RowGroup,
    selected: readonly string[],
    depth = 0,
  ): ReactNode[] =>
    nodes.flatMap((node) => {
      if (node.kind === "file") {
        const { entry } = node;
        visible[group].push(entry.change.path);
        return [
          <ScmRow
            key={entry.change.path}
            entry={entry}
            group={group}
            depth={depth}
            selected={entry.change.path === openFile}
            bulk={actionTargets(selected, entry.change.path).length}
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
        ...(open ? rows(node.children, group, selected, depth + 1) : []),
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
    const selected = selectedOf(id as RowGroup);
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
            {selected.length > 1 && (
              <span
                className={styles.groupSelected}
                data-testid="scm-group-selected"
              >
                {selected.length} selected
              </span>
            )}
          </button>
          {actions && <span className={styles.actions}>{actions}</span>}
        </div>
        <Collapse open={open}>
          {rows(scmTree(entries), id as RowGroup, selected)}
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
    <div
      className={styles.list}
      data-testid="scm"
      data-view={view}
      onKeyDown={(e) => {
        // Escape lets a selection go first; the drawer closes on the next.
        if (
          e.key === "Escape" &&
          selection.group !== null &&
          selectedOf(selection.group).length > 0
        ) {
          e.preventDefault();
          e.stopPropagation();
          setSelection(NO_SELECTION);
        }
      }}
    >
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
          {...discardCopy(discarding?.paths ?? [], discarding?.untracked)}
          confirmVariant="danger"
          onCancel={() => setDiscarding(null)}
          onConfirm={() => {
            const pending = discarding;
            setDiscarding(null);
            if (pending) void act("discard", pending.paths, pending.untracked);
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
type OnRow = (
  action: RowAction,
  entry: ScmEntry,
  group: RowGroup,
  /** A row click's modifiers: they say how it changes the selection. */
  click?: Pick<MouseEvent, "shiftKey" | "metaKey" | "ctrlKey">,
) => void;

const filesLabel = (n: number) => (n === 1 ? "1 file" : `${n} files`);

/**
 * The discard confirm's words. An untracked file has nothing to go back to:
 * discarding it is `git clean`, so the dialog says it deletes.
 */
function discardCopy(
  paths: readonly string[],
  untracked: ReadonlySet<string> = new Set(),
): { title: string; description: string; confirmLabel: string } {
  if (paths.length === 1) {
    const [path] = paths;
    return untracked.has(path)
      ? {
          title: `Delete ${basename(path)}?`,
          description: `${basename(path)} is new and not tracked by git; discarding deletes it. This can't be undone.`,
          confirmLabel: "Delete",
        }
      : {
          title: "Discard changes?",
          description: `Your changes to ${path} will be lost. This can't be undone.`,
          confirmLabel: "Discard",
        };
  }
  if (untracked.size === paths.length) {
    return {
      title: `Delete ${filesLabel(paths.length)}?`,
      description:
        "They are new and not tracked by git; discarding deletes them. This can't be undone.",
      confirmLabel: "Delete",
    };
  }
  const deleted =
    untracked.size === 0
      ? ""
      : ` ${untracked.size === 1 ? "1 new file is" : `${untracked.size} new files are`} not tracked by git and will be deleted.`;
  return {
    title: `Discard changes in ${filesLabel(paths.length)}?`,
    description: `Your changes will be lost.${deleted} This can't be undone.`,
    confirmLabel: "Discard",
  };
}

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
  /** How many files its buttons act on: more than 1 when it is one of several selected. */
  bulk: number;
  webApp: boolean;
  /** A git action is running, or git can't be reached: its buttons wait. */
  locked: boolean;
  onRow: OnRow;
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
    a.bulk === b.bulk &&
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
  bulk,
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
      onClick={() => onRow(action, entry, group)}
    />
  );
  const many = bulk > 1;
  return (
    <div
      className={`${styles.row} ${selected ? styles.rowSelected : ""} ${many ? styles.rowInSelection : ""} ${styles[`letter_${letter}`]}`}
      data-testid="scm-row"
      data-path={change.path}
      data-letter={letter}
      data-in-selection={many ? "" : undefined}
    >
      <button
        type="button"
        className={styles.rowMain}
        style={{ paddingLeft: rowIndent(depth, true) }}
        title={
          change.status === "deleted" ? `${change.path} (deleted)` : change.path
        }
        aria-current={selected ? "true" : undefined}
        onClick={(e) => onRow("open", entry, group, e)}
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
                onRow("openFile", entry, group);
              }}
            >
              <FileCode size={13} />
            </button>
          </Tooltip>
        )}
        {group === "changes" &&
          gitButton(
            "discard",
            many
              ? `Discard ${filesLabel(bulk)}`
              : letter === "U"
                ? "Delete file"
                : "Discard changes",
            "scm-discard",
            <Undo2 size={13} />,
          )}
        {group === "changes" &&
          gitButton(
            "stage",
            many ? `Stage ${filesLabel(bulk)}` : "Stage",
            "scm-stage",
            <Plus size={13} />,
          )}
        {group === "staged" &&
          gitButton(
            "unstage",
            many ? `Unstage ${filesLabel(bulk)}` : "Unstage",
            "scm-unstage",
            <Minus size={13} />,
          )}
      </span>
      <span className={styles.letter} data-testid="scm-letter">
        {letter}
      </span>
    </div>
  );
}, sameRow);
