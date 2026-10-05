import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import * as Popover from "@radix-ui/react-popover";
import ListFilter from "lucide-react/dist/esm/icons/list-filter";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import X from "lucide-react/dist/esm/icons/x";
import { Button } from "../ui/Button/Button";
import { Checkbox } from "../ui/Checkbox/Checkbox";
import { CountBadge } from "../ui/CountBadge/CountBadge";
import { Input } from "../ui/Input";
import {
  TASK_FIELDS,
  facetLabel,
  facetOptions,
  filterableFields,
  type LinkedTask,
  type TaskFieldId,
  type TaskFilters,
  type TaskProvider,
  type TaskRow,
} from "../../lib/tasks";
import { activeFilterCount, onMenuListKeyDown } from "./task-menus";
import styles from "./TaskFilterMenu.module.css";

type TaskFilterMenuProps = {
  provider: TaskProvider;
  /** The rows before filtering, so option counts don't move as filters change. */
  rows: readonly (TaskRow | LinkedTask)[];
  filters: TaskFilters;
  onChange: (next: TaskFilters) => void;
};

/** Past this many values a field's list gets a search box. */
const SEARCH_THRESHOLD = 8;

/** `filters` with one value of one field ticked or unticked. */
function toggleFilterValue(
  filters: TaskFilters,
  id: TaskFieldId,
  value: string,
  checked: boolean,
): TaskFilters {
  const current = filters[id] ?? [];
  const values = checked
    ? [...current, value]
    : current.filter((v) => v !== value);
  const next = { ...filters };
  if (values.length > 0) next[id] = values;
  else delete next[id];
  return next;
}

/**
 * The Filter button (ADR-201 §5): a popover listing the provider's
 * filterable fields; picking one shows its values, with counts from the
 * loaded rows, as checkboxes.
 */
export function TaskFilterMenu(props: TaskFilterMenuProps) {
  const { provider, rows, filters, onChange } = props;

  const [open, setOpen] = useState(false);
  const [field, setField] = useState<TaskFieldId | null>(null);
  // The field just left via Back, so the field list can refocus it.
  const [returnTo, setReturnTo] = useState<TaskFieldId | null>(null);
  const [query, setQuery] = useState("");
  const count = activeFilterCount(filters);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setField(null);
      setReturnTo(null);
      setQuery("");
    }
  };

  const toggle = (id: TaskFieldId, value: string, checked: boolean) =>
    onChange(toggleFilterValue(filters, id, value, checked));

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <Button
          variant="secondary"
          className={`${styles.trigger} ${count > 0 ? styles.triggerActive : ""}`}
          aria-label={count > 0 ? `Filter, ${count} active` : "Filter"}
        >
          <ListFilter size={14} />
          Filter
          {count > 0 && <CountBadge count={count} size="sm" tone="accent" />}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={styles.popover}
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
        >
          {field === null ? (
            <FieldList
              provider={provider}
              filters={filters}
              returnTo={returnTo}
              onPick={(id) => {
                setField(id);
                setQuery("");
              }}
            />
          ) : (
            <ValueList
              field={field}
              rows={rows}
              chosen={filters[field] ?? []}
              query={query}
              onQuery={setQuery}
              onToggle={(value, checked) => toggle(field, value, checked)}
              onBack={() => {
                setReturnTo(field);
                setField(null);
              }}
            />
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

type TaskFilterChipProps = {
  field: TaskFieldId;
  /** The rows before filtering, so option counts don't move as filters change. */
  rows: readonly (TaskRow | LinkedTask)[];
  filters: TaskFilters;
  onChange: (next: TaskFilters) => void;
  onRemove: () => void;
};

/**
 * An active filter under the toolbar: "Field: values". Clicking it opens that
 * field's values, as the Filter menu shows them, to change the filter in
 * place; the × removes it.
 */
export function TaskFilterChip(props: TaskFilterChipProps) {
  const { field, rows, filters, onChange, onRemove } = props;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const chosen = filters[field] ?? [];
  const label = TASK_FIELDS[field].label;
  const text = chosen.map((v) => facetLabel(field, v)).join(", ");

  return (
    <span className={styles.chip}>
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setQuery("");
        }}
      >
        <Popover.Trigger asChild>
          <Button
            variant="ghost"
            className={styles.chipBody}
            aria-label={`Edit ${label} filter: ${text}`}
          >
            <span className={styles.chipField}>{label}:</span>
            <span className={styles.chipValues} title={text}>
              {text}
            </span>
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className={styles.popover}
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={8}
          >
            <ValueList
              field={field}
              rows={rows}
              chosen={chosen}
              query={query}
              onQuery={setQuery}
              onToggle={(value, checked) =>
                onChange(toggleFilterValue(filters, field, value, checked))
              }
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <Button
        variant="ghost"
        className={styles.chipRemove}
        aria-label={`Remove ${label} filter`}
        onClick={onRemove}
      >
        <X size={12} />
      </Button>
    </span>
  );
}

type FieldListProps = {
  provider: TaskProvider;
  filters: TaskFilters;
  /** Focused on mount — coming back from that field's values. */
  returnTo: TaskFieldId | null;
  onPick: (id: TaskFieldId) => void;
};

function FieldList(props: FieldListProps) {
  const { provider, filters, returnTo, onPick } = props;

  const listRef = useRef<HTMLDivElement>(null);

  // On open Radix focuses the first field; after Back, the field left.
  useEffect(() => {
    if (!returnTo) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-field="${returnTo}"]`)
      ?.focus();
  }, [returnTo]);

  return (
    <div
      ref={listRef}
      className={styles.list}
      role="group"
      aria-label="Filter by"
      onKeyDown={onMenuListKeyDown}
    >
      <div className={styles.heading}>Filter by</div>
      {filterableFields(provider).map((id) => {
        const chosen = filters[id]?.length ?? 0;
        return (
          <Button
            key={id}
            variant="ghost"
            className={styles.item}
            data-menu-item
            data-field={id}
            onClick={() => onPick(id)}
          >
            <span className={styles.itemLabel}>{TASK_FIELDS[id].label}</span>
            {chosen > 0 && <CountBadge count={chosen} size="sm" />}
            <ChevronRight size={13} className={styles.itemChevron} />
          </Button>
        );
      })}
    </div>
  );
}

type ValueListProps = {
  field: TaskFieldId;
  rows: readonly (TaskRow | LinkedTask)[];
  chosen: readonly string[];
  query: string;
  onQuery: (query: string) => void;
  onToggle: (value: string, checked: boolean) => void;
  /** Back to the Filter menu's field list; absent when opened from a chip. */
  onBack?: () => void;
};

function ValueList(props: ValueListProps) {
  const { field, rows, chosen, query, onQuery, onToggle, onBack } = props;

  const listRef = useRef<HTMLDivElement>(null);

  const options = useMemo(() => {
    const found = facetOptions(rows, field);
    const ordered = field === "status" ? byWorkflow(found, rows) : found;
    // A chosen value no loaded row carries any more stays, so it can be unticked.
    const missing = chosen
      .filter((v) => !found.some((o) => o.value === v))
      .map((value) => ({ value, count: 0 }));
    return [...ordered, ...missing];
  }, [rows, field, chosen]);

  const searchable = options.length > SEARCH_THRESHOLD;
  const q = query.trim().toLowerCase();
  const shown = q
    ? options.filter((o) =>
        facetLabel(field, o.value).toLowerCase().includes(q),
      )
    : options;

  // Moving into a field puts focus on its search box, else its first value.
  useEffect(() => {
    const target = listRef.current?.querySelector<HTMLElement>(
      "[data-autofocus], [data-menu-item]",
    );
    target?.focus();
  }, [field]);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const inSearch = (e.target as HTMLElement).tagName === "INPUT";
    if (onBack && e.key === "ArrowLeft" && !inSearch) {
      e.preventDefault();
      onBack();
      return;
    }
    if (onBack && e.key === "Backspace" && inSearch && query === "") {
      e.preventDefault();
      onBack();
      return;
    }
    onMenuListKeyDown(e);
  };

  return (
    <div
      ref={listRef}
      className={styles.list}
      role="group"
      aria-label={`${TASK_FIELDS[field].label} values`}
      onKeyDown={handleKeyDown}
    >
      {onBack ? (
        <Button
          variant="ghost"
          className={styles.back}
          onClick={onBack}
          aria-label={`Back to fields (${TASK_FIELDS[field].label})`}
        >
          <ChevronLeft size={13} />
          {TASK_FIELDS[field].label}
        </Button>
      ) : (
        <div className={styles.heading}>{TASK_FIELDS[field].label}</div>
      )}
      {searchable && (
        <Input
          className={styles.search}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={`Search ${TASK_FIELDS[field].label.toLowerCase()}`}
          aria-label={`Search ${TASK_FIELDS[field].label} values`}
          spellCheck={false}
          data-autofocus
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              listRef.current
                ?.querySelector<HTMLElement>("[data-menu-item]")
                ?.focus();
              e.stopPropagation();
            }
          }}
        />
      )}
      <div className={styles.values}>
        {shown.length === 0 ? (
          <div className={styles.none}>
            {options.length === 0 ? "No values in these tasks." : "No matches."}
          </div>
        ) : (
          shown.map((o) => {
            const checked = chosen.includes(o.value);
            return (
              <label key={o.value} className={styles.option}>
                <Checkbox
                  checked={checked}
                  onCheckedChange={(next) => onToggle(o.value, next === true)}
                  data-menu-item
                />
                <span className={styles.optionLabel}>
                  {facetLabel(field, o.value)}
                </span>
                <span className={styles.optionCount}>{o.count}</span>
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}

/**
 * Status values in workflow order (to do → started → done → canceled): each
 * value ranks as a row carrying it does under the Status sort.
 */
function byWorkflow(
  options: { value: string; count: number }[],
  rows: readonly (TaskRow | LinkedTask)[],
): { value: string; count: number }[] {
  const { compare } = TASK_FIELDS.status;
  if (!compare) return options;
  const sample = new Map<string, TaskRow | LinkedTask>();
  for (const row of rows) {
    if (!sample.has(row.status.label)) sample.set(row.status.label, row);
  }
  return [...options].sort((a, b) => {
    const ra = sample.get(a.value);
    const rb = sample.get(b.value);
    if (!ra || !rb) return ra ? -1 : rb ? 1 : 0;
    return compare(ra, rb);
  });
}
