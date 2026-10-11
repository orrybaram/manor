import { Button } from "../../ui/Button/Button";
import styles from "./ChatPane.module.css";
import { slashOptionId } from "./slash-commands";
import type { ListboxLevel } from "./useSlashCommands";

type CommandChoiceSheetProps = {
  /** Choices first, then "Other…", then "Open menu in terminal". */
  level: Extract<ListboxLevel, { kind: "choices" }>;
};

function scrollIntoViewNearest(node: HTMLElement | null) {
  node?.scrollIntoView({ block: "nearest" });
}

/**
 * The picker for a command with fixed arguments (ADR-218 D2): drawn where the
 * `/` menu was, one row per choice, then "Other…" and "Open menu in terminal".
 *
 * Like the `/` menu, focus stays in the composer's textarea (its
 * `aria-activedescendant` points at the selected row), so rows cancel pointer
 * and mouse down and act on click, which keeps the soft keyboard up. A tap
 * outside the sheet dismisses it.
 */
export function CommandChoiceSheet(props: CommandChoiceSheetProps) {
  const { level } = props;

  return (
    <>
      <div className={styles.choiceBackdrop} onPointerDown={level.dismiss} aria-hidden />
      <div className={styles.slashMenu} data-testid="command-choice-sheet">
        <div className={styles.choiceHeader}>/{level.command.name}</div>
        <div
          className={styles.slashMenuList}
          role="listbox"
          id={level.listboxId}
          aria-label={`/${level.command.name} options`}
        >
          {level.rows.map((row, index) => {
            const selected = index === level.selectedIndex;
            return (
              <Button
                key={row.key}
                ref={selected ? scrollIntoViewNearest : undefined}
                variant="ghost"
                id={slashOptionId(level.listboxId, index)}
                role="option"
                aria-selected={selected}
                tabIndex={-1}
                className={`${styles.slashItem} ${selected ? styles.slashItemSelected : ""}`}
                data-testid={row.testId}
                onPointerDown={(e) => e.preventDefault()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={row.activate}
              >
                <span className={styles.slashItemHead}>
                  <span className={styles.choiceLabel}>{row.label}</span>
                </span>
                {row.description && (
                  <span className={styles.slashItemDescription}>{row.description}</span>
                )}
              </Button>
            );
          })}
        </div>
      </div>
    </>
  );
}
