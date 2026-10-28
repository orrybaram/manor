import { useId, useState } from "react";
import type { ChatEntry } from "../../../electron.d";
import { Button } from "../../ui/Button/Button";
import { diffLines, editPathParts, hunkHeader, ratioBlocks } from "./edit-diff";
import styles from "./ChatPane.module.css";

type EditCardProps = {
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
 * five-block bar of the add/remove ratio. "Show diff" opens the hunks.
 */
export function EditCard(props: EditCardProps) {
  const { entry } = props;

  const [open, setOpen] = useState(false);
  const diffId = useId();
  const { name, folder } = editPathParts(entry.path);
  const blocks = ratioBlocks(entry.added, entry.removed);

  return (
    <div className={styles.editCard} data-testid="chat-edit-card" data-edit-id={entry.id}>
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
      {open && (
        <div className={styles.editDiff} id={diffId} data-testid="chat-edit-diff">
          {entry.hunks.map((h, i) => (
            <div key={i} className={styles.diffHunk}>
              <div className={styles.diffHeader}>{hunkHeader(h)}</div>
              {diffLines(h).map((l, j) => (
                <div key={j} className={LINE_CLASS[l.kind]} data-line={l.kind}>
                  {l.sign && <span className={styles.diffSign}>{l.sign}</span>}
                  {l.text}
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
