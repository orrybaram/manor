import type { ChatCommand } from "../../../../electron/chat-mirror/builtin-commands";
import { Button } from "../../ui/Button/Button";
import styles from "./ChatPane.module.css";
import { slashOptionId } from "./slash-commands";

type SlashCommandMenuProps = {
  listboxId: string;
  items: ChatCommand[];
  selectedIndex: number;
  /** False until the session's skill list is known: say why none show. */
  skillsKnown: boolean;
  onPick: (index: number) => void;
};

function scrollIntoViewNearest(node: HTMLElement | null) {
  node?.scrollIntoView({ block: "nearest" });
}

/**
 * The composer's `/` list (ADR-217 D5): commands and skills matching what is
 * typed, drawn above the field without pushing the transcript.
 *
 * Focus never leaves the textarea (its `aria-activedescendant` points at the
 * selected row), so a tap must not blur it: pointer and mouse down are
 * cancelled and the pick happens on click, which keeps the soft keyboard up.
 */
export function SlashCommandMenu(props: SlashCommandMenuProps) {
  const { listboxId, items, selectedIndex, skillsKnown, onPick } = props;

  return (
    <div className={styles.slashMenu} data-testid="slash-command-menu">
      <div className={styles.slashMenuList} role="listbox" id={listboxId} aria-label="Commands">
        {items.map((item, index) => {
          const selected = index === selectedIndex;
          return (
            <Button
              key={item.name}
              ref={selected ? scrollIntoViewNearest : undefined}
              variant="ghost"
              id={slashOptionId(listboxId, index)}
              role="option"
              aria-selected={selected}
              tabIndex={-1}
              className={`${styles.slashItem} ${selected ? styles.slashItemSelected : ""}`}
              data-testid="slash-command-item"
              data-command={item.name}
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(index)}
            >
              <span className={styles.slashItemHead}>
                <span className={styles.slashItemName}>/{item.name}</span>
                {item.interactive && !item.choices && (
                  <span className={styles.slashItemTag}>Opens in terminal</span>
                )}
              </span>
              {item.description && (
                <span className={styles.slashItemDescription}>{item.description}</span>
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
