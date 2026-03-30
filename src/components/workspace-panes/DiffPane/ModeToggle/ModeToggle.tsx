import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import PencilLine from "lucide-react/dist/esm/icons/pencil-line";
import type { DiffMode } from "../types";
import styles from "./ModeToggle.module.css";

export function ModeToggle({ diffMode, onModeChange }: { diffMode: DiffMode; onModeChange: (mode: DiffMode) => void }) {
  return (
    <div className={styles.modeToggle}>
      <button
        className={`${styles.modeBtn} ${diffMode === "local" ? styles.modeBtnActive : ""}`}
        onClick={() => onModeChange("local")}
      >
        <PencilLine size={12} />
        Local Changes
      </button>
      <button
        className={`${styles.modeBtn} ${diffMode === "branch" ? styles.modeBtnActive : ""}`}
        onClick={() => onModeChange("branch")}
      >
        <GitBranch size={12} />
        Branch Diff
      </button>
    </div>
  );
}
