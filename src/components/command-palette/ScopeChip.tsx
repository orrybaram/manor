import X from "lucide-react/dist/esm/icons/x";
import { Button } from "../ui/Button/Button";
import styles from "./ScopeChip.module.css";

type ScopeChipProps = {
  /** The scoped project's name, or `null` when searching all projects. */
  projectName: string | null;
  /** First Backspace on an empty query arms the chip; the next one clears it. */
  armed: boolean;
  onClear: () => void;
};

/** Shows which projects the palette searches, inline before its input. */
export function ScopeChip(props: ScopeChipProps) {
  const { projectName, armed, onClear } = props;

  if (projectName === null) {
    return (
      <span
        className={`${styles.chip} ${styles.global}`}
        data-testid="palette-scope-chip"
        data-scope="global"
      >
        All projects
      </span>
    );
  }

  return (
    <span
      className={`${styles.chip} ${styles.scoped} ${armed ? styles.armed : ""}`}
      data-testid="palette-scope-chip"
      data-scope="project"
      data-armed={armed || undefined}
    >
      <span className={styles.name}>{projectName}</span>
      <Button
        variant="ghost"
        size="sm"
        className={styles.clear}
        aria-label="Search all projects"
        // Tab toggles scope in the palette input, so keep the × out of the
        // focus order; it stays clickable.
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClear}
      >
        <X size={12} />
      </Button>
    </span>
  );
}
