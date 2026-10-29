import { useOpenFileStore } from "../../../store/open-file-store";
import { fileTitle } from "../../../lib/pane-title";
import { formatCombo, getPlatform } from "../../../lib/keybindings";
import styles from "./FilePaneHeader.module.css";

/** A file pane's header title: the open file's name, and a dot while it has unsaved edits. */
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
