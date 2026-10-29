import { useMemo, useState } from "react";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down";
import { useOpenFileStore } from "../../../store/open-file-store";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import { AgentChip } from "./AgentChip";
import { jumpToEdit, useFileEditNav } from "./file-edit-nav";
import type { FilesWorkspace } from "./open-file-watches";
import { useWorkspaceChanges } from "./workspace-changes";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { fileTitle } from "../../../lib/pane-title";
import { formatCombo, getPlatform } from "../../../lib/keybindings";
import styles from "./FilePaneHeader.module.css";

const FLASH_MS = 1500;

/**
 * A file pane's header title: the open file's name, a dot while it has unsaved
 * edits, and a brief "Reloaded from disk" after a change on disk replaced it.
 */
export function FileHeaderTitle({
  paneId,
  filePath,
  className,
}: {
  paneId: string;
  filePath: string | null;
  className?: string;
}) {
  const dirty = useOpenFileStore((s) => s.byPane[paneId]?.dirty ?? false);
  const reloads = useOpenFileStore((s) => s.byPane[paneId]?.reloads ?? 0);
  // Reloads before this header mounted are old news.
  const [seen] = useState(reloads);
  return (
    <span className={styles.titleRow}>
      <span className={className} title={filePath ?? undefined}>
        {fileTitle(filePath)}
      </span>
      {dirty && (
        <span
          className={styles.dirty}
          data-testid="file-pane-dirty"
          title="Unsaved changes"
          aria-label="Unsaved changes"
        />
      )}
      {reloads > seen && <ReloadedFlash key={reloads} />}
    </span>
  );
}

function ReloadedFlash() {
  const [shown, setShown] = useState(true);
  useMountEffect(() => {
    const timer = setTimeout(() => setShown(false), FLASH_MS);
    return () => clearTimeout(timer);
  });
  if (!shown) return null;
  return (
    <span className={styles.flash} data-testid="file-pane-reloaded" role="status">
      Reloaded from disk
    </span>
  );
}

/** "⌘S to save" (Ctrl+S off macOS), on the header's right while there are unsaved edits. */
export function FileSaveHint({ paneId }: { paneId: string }) {
  const dirty = useOpenFileStore((s) => s.byPane[paneId]?.dirty ?? false);
  if (!dirty) return null;
  const mac = getPlatform() === "mac";
  const combo = formatCombo({ key: "s", meta: mac, ctrl: !mac, shift: false, alt: false });
  return (
    <span className={styles.hint} data-testid="file-pane-save-hint">
      {combo} to save
    </span>
  );
}

/**
 * The header's change jumps, while the open file has changes since the last
 * commit and no unsaved edits (then the header says "⌘S to save"): the
 * agent's chip when one wrote the file last, "N of M changes" ("M changes"
 * before the first jump), and ↑/↓, which ⌥↑/⌥↓ in the editor match. The
 * changes are the workspace diff's, so they include your own saved edits.
 */
export function FileEditJump({
  paneId,
  workspacePath,
  hostId,
  filePath,
}: {
  paneId: string;
  workspacePath: string | null;
  hostId: string | null;
  filePath: string | null;
}) {
  const dirty = useOpenFileStore((s) => s.byPane[paneId]?.dirty ?? false);
  const nav = useFileEditNav((s) => s.byPane[paneId]);
  const workspace = useMemo<FilesWorkspace | null>(
    () => (workspacePath && hostId ? { path: workspacePath, hostId } : null),
    [workspacePath, hostId],
  );
  const changes = useWorkspaceChanges(workspace);
  if (dirty || !nav || nav.count === 0) return null;
  const author = filePath ? (changes?.authors[filePath] ?? null) : null;
  const noun = nav.count === 1 ? "change" : "changes";
  return (
    <span className={styles.jump} data-testid="file-pane-edit-jump">
      {author && <AgentChip author={author} />}
      <span className={styles.jumpLabel} data-testid="file-pane-edit-jump-label">
        {nav.current !== null && (
          <>
            <b>{nav.current + 1}</b> of{" "}
          </>
        )}
        {nav.count} {noun}
      </span>
      <Tooltip label="Previous change (⌥↑)">
        <button
          type="button"
          className={styles.jumpBtn}
          aria-label="Previous change"
          data-testid="file-pane-edit-prev"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            jumpToEdit(paneId, -1);
          }}
        >
          <ArrowUp size={12} />
        </button>
      </Tooltip>
      <Tooltip label="Next change (⌥↓)">
        <button
          type="button"
          className={styles.jumpBtn}
          aria-label="Next change"
          data-testid="file-pane-edit-next"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            jumpToEdit(paneId, 1);
          }}
        >
          <ArrowDown size={12} />
        </button>
      </Tooltip>
    </span>
  );
}
