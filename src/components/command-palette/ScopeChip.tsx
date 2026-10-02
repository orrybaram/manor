import { useMemo } from "react";
import X from "lucide-react/dist/esm/icons/x";
import { projectColorStyle } from "../../hooks/useProjectHeaderRow";
import type { ProjectInfo } from "../../store/project-store";
import { Button } from "../ui/Button/Button";
import {
  SearchableSelect,
  type SearchableSelectOption,
} from "../ui/SearchableSelect/SearchableSelect";
import styles from "./ScopeChip.module.css";

const ALL_PROJECTS = "__all__";

type ScopeChipProps = {
  /** Projects the palette can be scoped to. */
  projects: readonly ProjectInfo[];
  /** The scoped project, or `null` when searching all projects. */
  project: ProjectInfo | null;
  /** First Backspace on an empty query arms the chip; the next one clears it. */
  armed: boolean;
  /** Scope to a project, or `null` for all projects. */
  onChange: (projectId: string | null) => void;
  onClear: () => void;
};

/**
 * Shows which projects the palette searches, inline before its input, and
 * picks another. Tinted with the scoped project's colour.
 */
export function ScopeChip(props: ScopeChipProps) {
  const { projects, project, armed, onChange, onClear } = props;

  const options = useMemo<SearchableSelectOption[]>(
    () => [
      { value: ALL_PROJECTS, label: "All projects" },
      ...projects.map((p) => ({
        value: p.id,
        label: p.name,
        icon: <span className={styles.dot} style={projectColorStyle(p.color)} />,
      })),
    ],
    [projects],
  );

  return (
    <span
      className={`${styles.chip} ${project ? styles.scoped : styles.global} ${armed ? styles.armed : ""}`}
      style={projectColorStyle(project?.color)}
      data-testid="palette-scope-chip"
      data-scope={project ? "project" : "global"}
      data-armed={armed || undefined}
      // The picker renders inside cmdk's root: keep its keys from driving the list.
      onKeyDown={(e) => e.stopPropagation()}
    >
      <SearchableSelect
        value={project?.id ?? ALL_PROJECTS}
        onChange={(v) => onChange(v === ALL_PROJECTS ? null : v)}
        options={options}
        icon={project && <span className={styles.dot} />}
        maxWidth={200}
        className={styles.trigger}
        emptyMessage="No projects"
      />
      {project && (
        <Button
          variant="ghost"
          size="sm"
          className={styles.clear}
          aria-label="Search all projects"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClear}
        >
          <X size={12} />
        </Button>
      )}
    </span>
  );
}
