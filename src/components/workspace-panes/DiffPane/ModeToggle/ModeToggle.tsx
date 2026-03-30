import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import CircleDotDashed from "lucide-react/dist/esm/icons/circle-dot-dashed";
import type { DiffMode } from "../types";
import styles from "./ModeToggle.module.css";

export function ModeToggle({ diffMode, onModeChange }: { diffMode: DiffMode; onModeChange: (mode: DiffMode) => void }) {
  return (
    <div className={styles.modeToggle}>
      <button
        className={`${styles.modeBtn} ${diffMode === "local" ? styles.modeBtnActive : ""}`}
        onClick={() => onModeChange("local")}
      >
        <CircleDotDashed size={12} />
        Uncommitted
      </button>
      <button
        className={`${styles.modeBtn} ${diffMode === "branch" ? styles.modeBtnActive : ""}`}
        onClick={() => onModeChange("branch")}
      >
        <GitBranch size={12} />
        Branch
      </button>
    </div>
  );
}
