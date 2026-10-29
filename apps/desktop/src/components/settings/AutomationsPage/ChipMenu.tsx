import { useState, type KeyboardEvent, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import { Button } from "../../ui/Button/Button";
import styles from "./AutomationsPage.module.css";

/** The parts of the sentence a chip can change. */
export type ChipKind = "schedule" | "agent" | "project" | "host" | "workspace";

type ChipMenuProps = {
  kind: ChipKind;
  label: string;
  /** What the menu is for, for screen readers: "Schedule", "Agent". */
  title: string;
  /** The menu's rows; `close` shuts it after a pick. */
  children: (close: () => void) => ReactNode;
};

/** Up / Down / Home / End move between a menu's rows. */
function onMenuKeyDown(e: KeyboardEvent<HTMLElement>): void {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(e.key)) return;
  if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "SELECT") {
    return;
  }
  const items = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not(:disabled)'),
  );
  if (items.length === 0) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? items.length - 1
        : e.key === "ArrowDown"
          ? (at + 1) % items.length
          : (at - 1 + items.length) % items.length;
  items[next]?.focus();
}

/**
 * One bracket of the "When and where" sentence: a chip showing the value,
 * opening a menu of the others. Radix `Popover` closes it on Escape and an
 * outside tap or click.
 */
export function ChipMenu(props: ChipMenuProps) {
  const { kind, label, title, children } = props;
  const [open, setOpen] = useState(false);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={styles.chip}
          aria-haspopup="menu"
          aria-label={`${title}: ${label}`}
          data-testid={`automation-chip-${kind}`}
        >
          {label}
          <ChevronDown size={10} aria-hidden className={styles.chipCaret} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={styles.menu}
          data-testid={`automation-menu-${kind}`}
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(e) => {
            // Focus the chosen row, so arrows start from it.
            e.preventDefault();
            const target = e.currentTarget as HTMLElement | null;
            const chosen =
              target?.querySelector<HTMLElement>('[aria-checked="true"]') ??
              target?.querySelector<HTMLElement>('[role="menuitemradio"]');
            chosen?.focus();
          }}
        >
          <div role="menu" aria-label={title} className={styles.menuList} onKeyDown={onMenuKeyDown}>
            {children(() => setOpen(false))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A chip that can't change: shown where the value is fixed. */
export function StaticChip(props: { kind: ChipKind; label: string; title: string }) {
  return (
    <span className={styles.chipStatic} title={props.title} data-testid={`automation-chip-${props.kind}`}>
      {props.label}
    </span>
  );
}

type MenuItemProps = {
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
  hint?: string;
  testId?: string;
  children: ReactNode;
};

export function MenuItem(props: MenuItemProps) {
  const { selected, onSelect, disabled, hint, testId, children } = props;
  return (
    <Button
      variant="ghost"
      size="sm"
      role="menuitemradio"
      aria-checked={selected}
      className={styles.menuItem}
      disabled={disabled}
      data-testid={testId}
      onClick={onSelect}
    >
      {children}
      {hint && <span className={styles.menuItemHint}>{hint}</span>}
    </Button>
  );
}

export function MenuDivider() {
  return <div className={styles.menuDivider} role="separator" />;
}
