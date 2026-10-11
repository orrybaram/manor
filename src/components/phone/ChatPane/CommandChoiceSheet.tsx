import type { ChatCommand } from "../../../../electron/chat-mirror/builtin-commands";
import { Button } from "../../ui/Button/Button";
import styles from "./ChatPane.module.css";
import { slashOptionId } from "./slash-commands";

type CommandChoiceSheetProps = {
  command: ChatCommand;
  /** Choices first, then "Other…", then "Open menu in terminal". */
  selectedIndex: number;
  listboxId: string;
  onChoose: (value: string) => void;
  onOther: () => void;
  onOpenInTerminal: () => void;
  /** Tap outside the sheet. */
  onDismiss: () => void;
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
 * and mouse down and act on click, which keeps the soft keyboard up.
 */
export function CommandChoiceSheet(props: CommandChoiceSheetProps) {
  const { command, selectedIndex, listboxId, onChoose, onOther, onOpenInTerminal, onDismiss } =
    props;
  const choices = command.choices ?? [];

  const row = (
    index: number,
    key: string,
    testId: string,
    onClick: () => void,
    label: string,
    description?: string,
  ) => {
    const selected = index === selectedIndex;
    return (
      <Button
        key={key}
        ref={selected ? scrollIntoViewNearest : undefined}
        variant="ghost"
        id={slashOptionId(listboxId, index)}
        role="option"
        aria-selected={selected}
        tabIndex={-1}
        className={`${styles.slashItem} ${selected ? styles.slashItemSelected : ""}`}
        data-testid={testId}
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
      >
        <span className={styles.slashItemHead}>
          <span className={styles.choiceLabel}>{label}</span>
        </span>
        {description && <span className={styles.slashItemDescription}>{description}</span>}
      </Button>
    );
  };

  return (
    <>
      <div className={styles.choiceBackdrop} onPointerDown={onDismiss} aria-hidden />
      <div className={styles.slashMenu} data-testid="command-choice-sheet">
        <div className={styles.choiceHeader}>/{command.name}</div>
        <div
          className={styles.slashMenuList}
          role="listbox"
          id={listboxId}
          aria-label={`/${command.name} options`}
        >
          {choices.map((choice, index) =>
            row(
              index,
              choice.value,
              `command-choice-${choice.value}`,
              () => onChoose(choice.value),
              choice.label,
              choice.description,
            ),
          )}
          {row(choices.length, "other", "command-choice-other", onOther, "Other…")}
          {row(
            choices.length + 1,
            "terminal",
            "command-choice-terminal",
            onOpenInTerminal,
            "Open menu in terminal",
          )}
        </div>
      </div>
    </>
  );
}
