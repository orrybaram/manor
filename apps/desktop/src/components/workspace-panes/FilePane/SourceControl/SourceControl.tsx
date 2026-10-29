import { createElement, useMemo, useState, type ReactNode } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import FileCode from "lucide-react/dist/esm/icons/file-code";
import Minus from "lucide-react/dist/esm/icons/minus";
import Plus from "lucide-react/dist/esm/icons/plus";
import Undo2 from "lucide-react/dist/esm/icons/undo-2";
import type { FileAuthor } from "../../../../electron.d";
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
} from "../../DiffPane/diff-fetch";
import { FingerprintedFetch } from "../../DiffPane/FingerprintedFetch";
import { AgentChip } from "../AgentChip";
import { fileChangesFromDiff, type FileChange } from "../file-changes";
import type { FilesWorkspace } from "../open-file-watches";
import type { WorkspaceChanges } from "../workspace-changes";
import { runGitFileAction, type GitFileAction } from "./git-actions";
import {
  branchEntries,
  localGroups,
  withStaged,
  type ScmEntry,
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
 * Source Control, the file pane drawer's second mode. Local: the working
 * changes in Staged and Changes, with stage, unstage and discard per file
 * and per group. Branch: everything changed since the project's default
 * branch, to read only. Both are fetched as the diff pane fetches them
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
    files: Set<string>;
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
  const [discarding, setDiscarding] = useState<string[] | null>(null);
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
    if (webApp || busy || files.length === 0) return;
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
  const authors = changes?.authors ?? {};

  const gitButton = (
    label: string,
    testId: string,
    icon: ReactNode,
    onClick: () => void,
    destructive = false,
  ) => (
    <Tooltip label={webApp ? NO_GIT_FROM_BROWSER : label}>
      <button
        type="button"
        className={`${styles.iconBtn} ${destructive ? styles.iconBtnDanger : ""}`}
        aria-label={label}
        // aria-disabled keeps the reason's tooltip reachable on hover.
        aria-disabled={webApp || busy ? true : undefined}
        data-testid={testId}
        onClick={(e) => {
          e.stopPropagation();
          if (!webApp && !busy) onClick();
        }}
      >
        {icon}
      </button>
    </Tooltip>
  );

  const rows = (entries: ScmEntry[], group: "staged" | "changes" | "branch") =>
    entries.map((entry) => {
      const path = entry.change.path;
      return (
        <ScmRow
          key={path}
          entry={entry}
          author={authors[path] ?? null}
          selected={path === openFile}
          onOpen={() => onOpenChange(entry.change, view)}
          actions={
            <>
              {entry.change.status !== "deleted" && (
                <Tooltip label="Open file">
                  <button
                    type="button"
                    className={styles.iconBtn}
                    aria-label="Open file"
                    data-testid="scm-open"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenFile(path);
                    }}
                  >
                    <FileCode size={13} />
                  </button>
                </Tooltip>
              )}
              {group === "changes" &&
                gitButton(
                  "Discard changes",
                  "scm-discard",
                  <Undo2 size={13} />,
                  () => setDiscarding([path]),
                  true,
                )}
              {group === "changes" &&
                gitButton(
                  "Stage",
                  "scm-stage",
                  <Plus size={13} />,
                  () => void act("stage", [path]),
                )}
              {group === "staged" &&
                gitButton(
                  "Unstage",
                  "scm-unstage",
                  <Minus size={13} />,
                  () => void act("unstage", [path]),
                )}
            </>
          }
        />
      );
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
          {rows(entries, id as "staged" | "changes" | "branch")}
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
          onResult={(files) =>
            setStagedResult({ key: wsKey, files: new Set(files) })
          }
        />
      ) : (
        <FingerprintedFetch
          key={branchKey}
          wsKey={wsKey}
          // The diff pane's Branch fetch, under the same key: one `git diff` for both.
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
          title="Discard changes?"
          description={
            discarding?.length === 1
              ? `Your changes to ${discarding[0]} will be lost. This can't be undone.`
              : `Your changes to ${discarding?.length ?? 0} files will be lost. This can't be undone.`
          }
          confirmLabel="Discard"
          confirmVariant="danger"
          onCancel={() => setDiscarding(null)}
          onConfirm={() => {
            const files = discarding ?? [];
            setDiscarding(null);
            void act("discard", files);
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

/** One changed file: icon, name, folder, its writer's chip, then actions and letter. */
function ScmRow({
  entry,
  author,
  selected,
  onOpen,
  actions,
}: {
  entry: ScmEntry;
  author: FileAuthor | null;
  selected: boolean;
  onOpen: () => void;
  actions: ReactNode;
}) {
  const { change, letter } = entry;
  const slash = change.path.lastIndexOf("/");
  const name = change.path.slice(slash + 1);
  const folder = slash < 0 ? "" : change.path.slice(0, slash);
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
        title={
          change.status === "deleted" ? `${change.path} (deleted)` : change.path
        }
        aria-current={selected ? "true" : undefined}
        onClick={onOpen}
      >
        {createElement(fileIconFor(change.path), {
          size: 12,
          className: styles.fileIcon,
        })}
        <span className={styles.name}>{name}</span>
        {folder && <span className={styles.folder}>{folder}</span>}
        {author && <AgentChip author={author} />}
      </button>
      <span className={styles.actions}>{actions}</span>
      <span className={styles.letter} data-testid="scm-letter">
        {letter}
      </span>
    </div>
  );
}
