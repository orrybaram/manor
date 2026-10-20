import { Button } from "../../ui/Button/Button";
import styles from "./ChatPane.module.css";
import { slashOptionId } from "./slash-commands";
import type { ListboxLevel } from "./useSlashCommands";

type SlashCommandMenuProps = {
  level: Extract<ListboxLevel, { kind: "commands" }>;
  /** False until the session's skill list is known: say why none show. */
  skillsKnown: boolean;
};

function scrollIntoViewNearest(node: HTMLElement | null) {
  node?.scrollIntoView({ block: "nearest" });
}

/**
 * The composer's `/` list: commands and skills matching what is
 * typed, drawn above the field without pushing the transcript.
 *
 * Focus never leaves the textarea (its `aria-activedescendant` points at the
 * selected row), so a tap must not blur it: pointer and mouse down are
 * cancelled and the pick happens on click, which keeps the soft keyboard up.
 */
export function SlashCommandMenu(props: SlashCommandMenuProps) {
  const { level, skillsKnown } = props;

  return (
    <div className={styles.slashMenu} data-testid="slash-command-menu">
      <div
        className={styles.slashMenuList}
        role="listbox"
        id={level.listboxId}
        aria-label="Commands"
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
              data-command={row.command}
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={row.activate}
            >
              <span className={styles.slashItemHead}>
                <span className={styles.slashItemName}>{row.label}</span>
                {row.tag && <span className={styles.slashItemTag}>{row.tag}</span>}
              </span>
              {row.description && (
                <span className={styles.slashItemDescription}>{row.description}</span>
              )}
            </Button>
          );
        })}
      </div>
      {!skillsKnown && (
        <div className={styles.slashMenuFooter} data-testid="slash-command-footer">
          Skills appear after your first message.
        </div>
      )}
    </div>
  );
}
