import { fileTitle } from "../../lib/pane-title";
import styles from "./UnsavedFiles.module.css";

/**
 * "Unsaved changes to <name><end>", or, for several, how many and then each
 * of them by path: a confirm names every file it is about, never only the
 * first. `end` closes the sentence (". " or " will be lost."); before a
 * list its full stop becomes a colon.
 */
export function UnsavedFiles({ files, end }: { files: readonly string[]; end: string }) {
  if (files.length === 0) return null;
  if (files.length === 1) {
    return (
      <div>
        Unsaved changes to{" "}
        <b data-testid="unsaved-file" title={files[0]}>
          {fileTitle(files[0])}
        </b>
        {end}
      </div>
    );
  }
  return (
    <div>
      Unsaved changes to {files.length} files{end.replace(/\.$/, ":")}
      <ul className={styles.list}>
        {files.map((file, i) => (
          <li key={`${i}:${file}`} className={styles.file} data-testid="unsaved-file">
            {file}
          </li>
        ))}
      </ul>
    </div>
  );
}
