import * as Popover from "@radix-ui/react-popover";
import ArrowUpDown from "lucide-react/dist/esm/icons/arrow-up-down";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down";
import Check from "lucide-react/dist/esm/icons/check";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal";
import { Button } from "../ui/Button/Button";
import { Checkbox } from "../ui/Checkbox/Checkbox";
import { ToggleGroup } from "../ui/ToggleGroup";
import {
  TASK_FIELDS,
  sortableFields,
  type TaskProvider,
  type TaskSort,
} from "../../lib/tasks";
import { initialDirection, onMenuListKeyDown } from "./task-menus";
import { columnLabel, type TaskColumnId } from "./task-columns";
import styles from "./TaskDisplayMenu.module.css";

type TaskDisplayMenuProps = {
  provider: TaskProvider;
  sort: TaskSort;
  onChange: (next: TaskSort) => void;
  /** The provider's hideable columns, from `columnsFor`. */
  columns: readonly TaskColumnId[];
  /** The hidden set for the table as it is now (beside the drawer or not). */
  hidden: readonly TaskColumnId[];
  onToggleColumn: (column: TaskColumnId) => void;
  onResetWidths: () => void;
};

type Direction = TaskSort["direction"];

const DIRECTION_OPTIONS: { value: Direction; label: string }[] = [
  { value: "asc", label: "Ascending" },
  { value: "desc", label: "Descending" },
];

/**
 * The Display button: the sort (every sortable field of the provider, plus
 * the direction) and which columns the table shows. The button names the
 * sort, so it stays visible.
 */
export function TaskDisplayMenu(props: TaskDisplayMenuProps) {
  const {
    provider,
    sort,
    onChange,
    columns,
    hidden,
    onToggleColumn,
    onResetWidths,
  } = props;

  const Arrow = sort.direction === "asc" ? ArrowUp : ArrowDown;
  const directionWord = sort.direction === "asc" ? "ascending" : "descending";

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button
          variant="secondary"
          className={styles.trigger}
          aria-label={`Display: sorted by ${TASK_FIELDS[sort.field].label}, ${directionWord}`}
          data-testid="tasks-display-menu"
        >
          <SlidersHorizontal size={14} />
          <span className={styles.triggerDim}>Display</span>
          <ArrowUpDown size={12} className={styles.triggerDim} />
          {TASK_FIELDS[sort.field].label}
          <Arrow size={12} className={styles.triggerArrow} />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={styles.popover}
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
        >
          <div className={styles.direction}>
            <ToggleGroup
              value={sort.direction}
              onChange={(direction) => onChange({ ...sort, direction })}
              options={DIRECTION_OPTIONS}
              size="sm"
              aria-label="Sort direction"
            />
          </div>
          <div
            className={styles.list}
            role="group"
            aria-label="Sort by"
            onKeyDown={onMenuListKeyDown}
          >
            <div className={styles.heading}>Sort by</div>
            {sortableFields(provider).map((id) => {
              const active = id === sort.field;
              return (
                <Button
                  key={id}
                  variant="ghost"
                  className={`${styles.item} ${active ? styles.itemActive : ""}`}
                  aria-pressed={active}
                  data-menu-item
                  onClick={() =>
                    onChange(
                      active
                        ? sort
                        : { field: id, direction: initialDirection(id) },
                    )
                  }
                >
                  <span className={styles.itemLabel}>
                    {TASK_FIELDS[id].label}
                  </span>
                  {active && <Check size={13} className={styles.itemCheck} />}
                </Button>
              );
            })}
          </div>
          <div
            className={`${styles.list} ${styles.columns}`}
            role="group"
            aria-label="Columns"
            onKeyDown={onMenuListKeyDown}
          >
            <div className={styles.heading}>Columns</div>
            <label className={`${styles.item} ${styles.itemDisabled}`}>
              <Checkbox checked disabled aria-label="Title / Context" />
              <span className={styles.itemLabel}>Title / Context</span>
            </label>
            {columns.map((id) => (
              <label key={id} className={styles.item}>
                <Checkbox
                  checked={!hidden.includes(id)}
                  onCheckedChange={() => onToggleColumn(id)}
                  data-menu-item
                />
                <span className={styles.itemLabel}>{columnLabel(id)}</span>
              </label>
            ))}
            <Button
              variant="ghost"
              className={styles.item}
              data-menu-item
              onClick={onResetWidths}
            >
              <span className={styles.itemLabel}>Reset widths</span>
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
