import * as Popover from "@radix-ui/react-popover";
import Check from "lucide-react/dist/esm/icons/check";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal";
import { Button } from "../../ui/Button/Button";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import { onMenuListKeyDown } from "../../tasks/task-menus";
import styles from "../../tasks/TaskDisplayMenu.module.css";
import pickerStyles from "./ThemePicker.module.css";
import { THEME_SORTS, type ThemeSort } from "./theme-picker";

type ThemeSortMenuProps = {
  sort: ThemeSort;
  onChange: (next: ThemeSort) => void;
};

/**
 * The wall's sort, as the Tasks view's Display button: the button is its
 * icon, its tooltip names the sort.
 */
export function ThemeSortMenu({ sort, onChange }: ThemeSortMenuProps) {
  const current = THEME_SORTS.find((o) => o.id === sort)?.label ?? sort;
  const label = `Sorted by ${current.toLowerCase()}`;

  return (
    <Popover.Root>
      <Tooltip label={label}>
        <Popover.Trigger asChild>
          <Button
            variant="secondary"
            className={styles.trigger}
            aria-label={label}
            data-testid="theme-sort-menu"
          >
            <SlidersHorizontal size={14} />
          </Button>
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content
          className={pickerStyles.sortPopover}
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
        >
          <div
            className={styles.list}
            role="group"
            aria-label="Sort by"
            onKeyDown={onMenuListKeyDown}
          >
            <div className={styles.heading}>Sort by</div>
            {THEME_SORTS.map((o) => {
              const active = o.id === sort;
              return (
                <Button
                  key={o.id}
                  variant="ghost"
                  className={`${styles.item} ${active ? styles.itemActive : ""}`}
                  aria-pressed={active}
                  data-menu-item
                  data-testid={`theme-sort-${o.id}`}
                  onClick={() => onChange(o.id)}
                >
                  <span className={styles.itemLabel}>{o.label}</span>
                  {active && <Check size={13} className={styles.itemCheck} />}
                </Button>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
