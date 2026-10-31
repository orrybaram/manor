import { useId, useRef, useState } from "react";
import type { ChatEntry } from "../../../electron.d";
import { editorIsManor, editorName, openInEditor } from "../../../lib/editor";
import { openFileBeside, splitDirectionBeside, workspaceOfPane } from "../../../lib/open-in-file-pane";
import { isWebApp } from "../../../lib/platform";
import { LOCAL_HOST_ID } from "../../../lib/workspace-key";
import { usePreferencesStore } from "../../../store/preferences-store";
import { Button } from "../../ui/Button/Button";
import { diffLines, editPathParts, hunkHeader, ratioBlocks } from "./edit-diff";
import styles from "./ChatPane.module.css";

type EditCardProps = {
  paneId: string;
  entry: Extract<ChatEntry, { kind: "edit" }>;
};

const LINE_CLASS = {
  add: styles.diffAdd,
  del: styles.diffDel,
  context: styles.diffContext,
  meta: styles.diffContext,
} as const;

const BLOCK_CLASS = {
  add: styles.ratioAdd,
  del: styles.ratioDel,
  none: undefined,
} as const;

/**
 * A landed edit, summary first: the file, its folder, `+n −m` and a
 * five-block bar of the add/remove ratio. "Show diff" opens the hunks, and
 * "Open in …" opens the file at the edit's first changed line.
 */
export function EditCard(props: EditCardProps) {
  const { paneId, entry } = props;
  const cardRef = useRef<HTMLDivElement>(null);
  const editor = usePreferencesStore((s) => editorName(s.preferences.defaultEditor));

  const [open, setOpen] = useState(false);
  const diffId = useId();
  const { name, folder } = editPathParts(entry.path);
  const blocks = ratioBlocks(entry.added, entry.removed);

  return (
    <div ref={cardRef} className={styles.editCard} data-testid="chat-edit-card" data-edit-id={entry.id}>
      <div className={styles.editHead}>
        <div className={styles.editFile}>
          <div className={styles.editName}>{name || entry.name}</div>
          {folder && <div className={styles.editFolder}>{folder}</div>}
        </div>
        <span className={styles.editCounts} aria-label={`${entry.added} added, ${entry.removed} removed`}>
          <span className={styles.editAdded}>+{entry.added}</span>
          <span className={styles.editRemoved}>−{entry.removed}</span>
        </span>
      </div>
      <div className={styles.ratioBar} aria-hidden>
        {blocks.map((b, i) => (
          <span key={i} className={BLOCK_CLASS[b]} />
        ))}
      </div>
      <div className={styles.editActions}>
        <Button
          variant="link"
          className={styles.editToggle}
          aria-expanded={open}
          aria-controls={diffId}
          data-testid="chat-edit-toggle"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide diff" : "Show diff"}
        </Button>
        {canOpen(paneId) && (
          <Button
            variant="link"
            className={styles.editToggle}
            data-testid="chat-edit-open"
            onClick={() => openEdit(paneId, entry, cardRef.current)}
          >
            Open in {editor}
          </Button>
        )}
      </div>
      {open && (
        <div className={styles.editDiff} id={diffId} data-testid="chat-edit-diff">
          {entry.hunks.map((h, i) => (
            <div key={i} className={styles.diffHunk}>
              <div className={styles.diffHeader}>{hunkHeader(h)}</div>
              {diffLines(h).map((l, j) => (
                <div key={j} className={LINE_CLASS[l.kind]} data-line={l.kind}>
                  {l.kind !== "meta" && (
                    <span className={styles.diffSign} aria-hidden>
                      {`${l.sign} `}
                    </span>
                  )}
                  <span>{l.text}</span>
                </div>
              ))}
            </div>
          ))}
          {entry.truncated && <div className={styles.diffTruncated}>Diff truncated</div>}
        </div>
      )}
    </div>
  );
}

/**
 * Only on this machine: the phone's browser has no editor to open, and a
 * remote host's paths aren't this machine's.
 */
function canOpen(paneId: string): boolean {
  return !isWebApp() && workspaceOfPane(paneId)?.hostId === LOCAL_HOST_ID;
}

/**
 * Open an edited file: a workspace file in a file pane beside the chat when
 * Manor is the editor, anything else in the editor (with none set, the
 * system's default app).
 */
function openEdit(
  paneId: string,
  entry: EditCardProps["entry"],
  card: HTMLElement | null,
): void {
  const workspace = workspaceOfPane(paneId);
  if (!workspace) return;
  const relative = !entry.path.startsWith("/");
  if (relative && editorIsManor()) {
    const line = entry.hunks[0]?.newStart;
    openFileBeside(paneId, entry.path, splitDirectionBeside(card), { line });
    return;
  }
  openInEditor(relative ? `${workspace.path}/${entry.path}` : entry.path);
}
