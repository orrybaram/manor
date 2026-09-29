import * as Popover from "@radix-ui/react-popover";
import ArrowUpDown from "lucide-react/dist/esm/icons/arrow-up-down";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down";
import Check from "lucide-react/dist/esm/icons/check";
import { Button } from "../ui/Button/Button";
import { ToggleGroup } from "../ui/ToggleGroup";
import {
  TASK_FIELDS,
  sortableFields,
  type TaskProvider,
  type TaskSort,
} from "../../lib/tasks";
import { initialDirection, onMenuListKeyDown } from "./task-menus";
import styles from "./TaskSortMenu.module.css";

type TaskSortMenuProps = {
  provider: TaskProvider;
  sort: TaskSort;
  onChange: (next: TaskSort) => void;
};

type Direction = TaskSort["direction"];

const DIRECTION_OPTIONS: { value: Direction; label: string }[] = [
  { value: "asc", label: "Ascending" },
  { value: "desc", label: "Descending" },
];

/**
 * The Sort button (ADR-201 §5): every sortable field of the provider, plus
 * the direction.
 */
export function TaskSortMenu(props: TaskSortMenuProps) {
  const { provider, sort, onChange } = props;

  const Arrow = sort.direction === "asc" ? ArrowUp : ArrowDown;
  const directionWord = sort.direction === "asc" ? "ascending" : "descending";

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button
          variant="secondary"
          className={styles.trigger}
          aria-label={`Sort: ${TASK_FIELDS[sort.field].label}, ${directionWord}`}
        >
          <ArrowUpDown size={14} />
          <span className={styles.triggerDim}>Sort:</span>
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
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
