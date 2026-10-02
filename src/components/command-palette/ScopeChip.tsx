import { useMemo } from "react";
import X from "lucide-react/dist/esm/icons/x";
import { projectColorStyle } from "../../hooks/useProjectHeaderRow";
import { Button } from "../ui/Button/Button";
import {
  SearchableSelect,
  type SearchableSelectOption,
} from "../ui/SearchableSelect/SearchableSelect";
import type { PaletteScopeEntry } from "./scope";
import styles from "./ScopeChip.module.css";

const ALL_PROJECTS = "__all__";

type ScopeChipProps = {
  /** What the palette can be scoped to: projects, linked checkouts as one. */
  entries: readonly PaletteScopeEntry[];
  /** The current scope, or `null` when searching all projects. */
  scope: PaletteScopeEntry | null;
  /** First Backspace on an empty query arms the chip; the next one clears it. */
  armed: boolean;
  /** Scope to an entry (by its `id`), or `null` for all projects. */
  onChange: (projectId: string | null) => void;
  onClear: () => void;
};

/**
 * Shows which projects the palette searches, inline before its input, and
 * picks another. Tinted with the scoped project's colour.
 */
export function ScopeChip(props: ScopeChipProps) {
  const { entries, scope, armed, onChange, onClear } = props;

  const options = useMemo<SearchableSelectOption[]>(
    () => [
      { value: ALL_PROJECTS, label: "All projects" },
      ...entries.map((e) => ({
        value: e.id,
        label: e.name,
        icon: <span className={styles.dot} style={projectColorStyle(e.color)} />,
      })),
    ],
    [entries],
  );

  return (
    <span
      className={`${styles.chip} ${scope ? styles.scoped : styles.global} ${armed ? styles.armed : ""}`}
      style={projectColorStyle(scope?.color)}
      data-testid="palette-scope-chip"
      data-scope={scope ? "project" : "global"}
      data-armed={armed || undefined}
      // The picker renders inside cmdk's root: keep its keys from driving the list.
      onKeyDown={(e) => e.stopPropagation()}
    >
      <SearchableSelect
        value={scope?.id ?? ALL_PROJECTS}
        onChange={(v) => onChange(v === ALL_PROJECTS ? null : v)}
        options={options}
        icon={scope && <span className={styles.dot} />}
        maxWidth={200}
        className={styles.trigger}
        emptyMessage="No projects"
      />
      {scope && (
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
