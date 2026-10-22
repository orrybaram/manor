import type { ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import Check from "lucide-react/dist/esm/icons/check";
import { columnLabel, type TaskColumnId } from "./task-columns";
import styles from "./TaskDisplayMenu.module.css";

type ColumnsContextMenuProps = {
  /** The header row it opens from. */
  children: ReactNode;
  columns: readonly TaskColumnId[];
  hidden: readonly TaskColumnId[];
  onToggleColumn: (column: TaskColumnId) => void;
  onResetWidths: () => void;
};

/** Right-clicking the table's header: the Display menu's Columns list. */
export function ColumnsContextMenu(props: ColumnsContextMenuProps) {
  const { children, columns, hidden, onToggleColumn, onResetWidths } = props;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className={styles.popover}
          collisionPadding={8}
          data-testid="tasks-columns-context-menu"
        >
          <div className={styles.heading}>Columns</div>
          <ContextMenu.CheckboxItem
            className={`${styles.contextItem} ${styles.itemDisabled}`}
            checked
            disabled
          >
            <span className={styles.itemLabel}>Title / Context</span>
            <Check size={13} className={styles.itemCheck} />
          </ContextMenu.CheckboxItem>
          {columns.map((id) => (
            <ContextMenu.CheckboxItem
              key={id}
              className={styles.contextItem}
              checked={!hidden.includes(id)}
              onCheckedChange={() => onToggleColumn(id)}
              // Stay open, so several columns can be toggled in a row.
              onSelect={(e) => e.preventDefault()}
            >
              <span className={styles.itemLabel}>{columnLabel(id)}</span>
              <ContextMenu.ItemIndicator>
                <Check size={13} className={styles.itemCheck} />
              </ContextMenu.ItemIndicator>
            </ContextMenu.CheckboxItem>
          ))}
          <ContextMenu.Separator className={styles.separator} />
          <ContextMenu.Item
            className={styles.contextItem}
            onSelect={onResetWidths}
          >
            <span className={styles.itemLabel}>Reset widths</span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
