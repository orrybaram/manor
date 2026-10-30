import React, {
  useState,
  useRef,
  useCallback,
  useMemo,
  useEffect,
} from "react";
import * as Popover from "@radix-ui/react-popover";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import Plus from "lucide-react/dist/esm/icons/plus";
import Check from "lucide-react/dist/esm/icons/check";
import styles from "./SearchableSelect.module.css";

export type SearchableSelectOption = {
  value: string;
  label: string;
  /** Shown before the label in the list. */
  icon?: React.ReactNode;
  /** A dimmer second line in the list that tells similar options apart. */
  hint?: string;
  /** Shown after the label, before the check mark, and on the trigger when
   *  selected. */
  trailing?: React.ReactNode;
  /**
   * Heading of the group the option is listed under. Options with a group
   * list in group order, each group under its heading, and the selected one
   * stays in its place instead of being pinned first.
   */
  group?: string;
  /** Why the option can't be picked: it stays listed, dimmed, with this as its hint. */
  disabledReason?: string | null;
};

/** A row after the options that does something other than pick a value. */
export type SearchableSelectAction = {
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  "data-testid"?: string;
};

type ListRow =
  | { kind: "option"; option: SearchableSelectOption }
  | { kind: "create"; query: string }
  | { kind: "action"; action: SearchableSelectAction };

const rowDisabled = (row: ListRow | undefined) =>
  row?.kind === "option" && !!row.option.disabledReason;

/** The next row from `from` in `step`'s direction that can be picked, wrapping. */
function nextEnabled(rows: ListRow[], from: number, step: 1 | -1): number {
  for (let i = 1; i <= rows.length; i++) {
    const index = (((from + step * i) % rows.length) + rows.length) % rows.length;
    if (!rowDisabled(rows[index])) return index;
  }
  return from;
}

type SearchableSelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: SearchableSelectOption[];
  placeholder?: string;
  icon?: React.ReactNode;
  maxWidth?: number;
  /** Extra class for the trigger, e.g. to size it to a toolbar. */
  className?: string;
  loading?: boolean;
  emptyMessage?: string;
  "data-testid"?: string;
  /** Set on the trigger button, so a `<label htmlFor>` can point at it. */
  id?: string;
  /**
   * Offers a "create" row at the end of the list for search text that
   * matches no option's label exactly. Called with the trimmed text.
   */
  onCreate?: (query: string) => void;
  /** The create row's label for a query; defaults to `Create "…"`. */
  createLabel?: (query: string) => string;
  /** The trigger's accessible name when no `<label>` points at it: a
   *  combobox is not named by the value it shows. */
  "aria-label"?: string;
  /** Max height of the options list in px. */
  listMaxHeight?: number;
  /** Shown on the trigger in place of the selected option's label. */
  triggerLabel?: React.ReactNode;
  /** Rows after the options, below a divider; they close the list when picked. */
  actions?: SearchableSelectAction[];
  /** The search field's placeholder, in place of "Search..." */
  searchPlaceholder?: string;
};

const LISTBOX_ID = "searchable-select-listbox";

export function SearchableSelect(props: SearchableSelectProps) {
  const {
    value,
    onChange,
    options,
    placeholder = "Select...",
    icon,
    maxWidth = 250,
    className,
    loading = false,
    emptyMessage = "No results",
    "data-testid": dataTestId,
    id,
    onCreate,
    createLabel = (q) => `Create "${q}"`,
    listMaxHeight = 200,
    triggerLabel,
    actions,
    searchPlaceholder,
  } = props;

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  // -1 until the user moves it: the first row that can be picked.
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => options.find((o) => o.value === value),
    [options, value],
  );
  const selectedLabel = selected ? selected.label : placeholder;

  const grouped = useMemo(() => options.some((o) => o.group), [options]);

  // Ungrouped, the selected option leads the list, above a divider. Grouped,
  // options keep their group's place, groups in the order they first appear.
  const filtered = useMemo(() => {
    const lower = search.toLowerCase();
    const matching = search
      ? options.filter((o) => o.label.toLowerCase().includes(lower))
      : options;
    if (grouped) {
      const order = [...new Set(matching.map((o) => o.group ?? ""))];
      return order.flatMap((g) => matching.filter((o) => (o.group ?? "") === g));
    }
    return [
      ...matching.filter((o) => o.value === value),
      ...matching.filter((o) => o.value !== value),
    ];
  }, [options, search, value, grouped]);
  const dividerAfterFirst =
    !grouped && filtered.length > 1 && filtered[0].value === value;

  // The text a create row would make, when there's one to offer.
  const createQuery = useMemo(() => {
    const trimmed = search.trim();
    if (!onCreate || !trimmed) return null;
    const lower = trimmed.toLowerCase();
    return options.some((o) => o.label.toLowerCase() === lower)
      ? null
      : trimmed;
  }, [onCreate, options, search]);
  // The create row and the actions sit after the options, so they're
  // reachable by arrow key.
  const rows = useMemo<ListRow[]>(
    () => [
      ...filtered.map((option) => ({ kind: "option" as const, option })),
      ...(createQuery ? [{ kind: "create" as const, query: createQuery }] : []),
      ...(actions ?? []).map((action) => ({ kind: "action" as const, action })),
    ],
    [filtered, createQuery, actions],
  );
  const rowCount = rows.length;
  // A disabled first row hands the highlight to the next one that isn't.
  const firstEnabled = rowDisabled(rows[0]) ? nextEnabled(rows, 0, 1) : 0;
  const active = highlightIndex === -1 ? firstEnabled : highlightIndex;

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setSearch("");
      setHighlightIndex(-1);
    }
  }, []);

  const selectOption = useCallback(
    (optionValue: string) => {
      onChange(optionValue);
      setOpen(false);
      setSearch("");
      setHighlightIndex(-1);
    },
    [onChange],
  );

  const runAction = useCallback((action: SearchableSelectAction) => {
    setOpen(false);
    setSearch("");
    setHighlightIndex(-1);
    action.onSelect();
  }, []);

  const create = useCallback(
    (query: string) => {
      onCreate?.(query);
      setOpen(false);
      setSearch("");
      setHighlightIndex(-1);
    },
    [onCreate],
  );

  const pickRow = useCallback(
    (row: ListRow | undefined) => {
      if (!row || rowDisabled(row)) return;
      if (row.kind === "option") selectOption(row.option.value);
      else if (row.kind === "create") create(row.query);
      else runAction(row.action);
    },
    [selectOption, create, runAction],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (rowCount === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIndex(nextEnabled(rows, active, 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIndex(nextEnabled(rows, active, -1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        pickRow(rows[active]);
      }
    },
    [rowCount, rows, active, pickRow],
  );

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
      setHighlightIndex(-1);
    },
    [],
  );
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-row="${active}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const highlightedId =
    rowCount > 0 ? `searchable-select-option-${active}` : undefined;

  /** One row of the list, named by its index for aria-activedescendant. */
  const renderRow = (row: ListRow, index: number) => {
    const disabled = rowDisabled(row);
    const highlighted = index === active && !disabled;
    const common = {
      id: `searchable-select-option-${index}`,
      "data-row": index,
      role: "option" as const,
      "aria-selected": highlighted,
      "aria-disabled": disabled || undefined,
      onMouseEnter: () => {
        if (!disabled) setHighlightIndex(index);
      },
      onMouseDown: (e: React.MouseEvent) => {
        e.preventDefault();
        pickRow(row);
      },
    };
    const classes = (...extra: (string | false | undefined)[]) =>
      [styles.option, highlighted && styles.optionHighlighted, ...extra]
        .filter(Boolean)
        .join(" ");

    if (row.kind === "create") {
      return (
        <div
          key="create"
          {...common}
          className={classes()}
          data-testid={dataTestId ? `${dataTestId}-create` : undefined}
        >
          <Plus size={12} />
          {createLabel(row.query)}
        </div>
      );
    }
    if (row.kind === "action") {
      const first = index === rowCount - (actions?.length ?? 0);
      return (
        <div
          key={`action-${row.action.label}`}
          {...common}
          className={classes(first && index > 0 && styles.actionFirst)}
          data-testid={row.action["data-testid"]}
        >
          {row.action.icon}
          <span className={styles.optionLabel}>{row.action.label}</span>
        </div>
      );
    }
    const { option } = row;
    const previous = rows[index - 1];
    const heading =
      grouped &&
      option.group &&
      (previous?.kind !== "option" || previous.option.group !== option.group)
        ? option.group
        : null;
    const hint = option.disabledReason || option.hint;
    return (
      <React.Fragment key={`${option.group ?? ""}:${option.value}`}>
        {heading && (
          <div
            className={`${styles.groupHeading} ${index > 0 ? styles.groupHeadingAfter : ""}`}
            role="presentation"
          >
            {heading}
          </div>
        )}
        <div
          {...common}
          className={classes(
            index === 0 && dividerAfterFirst && styles.optionSelected,
            disabled && styles.optionDisabled,
          )}
        >
          {option.icon}
          <span className={styles.optionLabel}>
            {option.label}
            {hint && <span className={styles.optionHint}>{hint}</span>}
          </span>
          {option.trailing && (
            <span className={styles.optionTrailing}>{option.trailing}</span>
          )}
          {option.value === value && (
            <Check size={12} className={styles.optionCheck} />
          )}
        </div>
      </React.Fragment>
    );
  };

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <button
          id={id}
          className={
            className ? `${styles.trigger} ${className}` : styles.trigger
          }
          style={{ maxWidth }}
          role="combobox"
          aria-label={props["aria-label"]}
          aria-expanded={open}
          aria-controls={LISTBOX_ID}
          data-testid={dataTestId}
          onKeyDown={(e) => {
            if (!open && e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
            }
          }}
        >
          <div className={styles.triggerContent}>
            {icon ?? selected?.icon}
            <span className={styles.triggerText}>
              {triggerLabel ?? selectedLabel}
            </span>
            {selected?.trailing && (
              <span className={styles.triggerTrailing}>{selected.trailing}</span>
            )}
          </div>
          <ChevronDown size={14} className={styles.chevron} />
        </button>
      </Popover.Trigger>
      <Popover.Content
        side="bottom"
        align="start"
        sideOffset={4}
        className={styles.content}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <input
          ref={inputRef}
          className={styles.searchInput}
          placeholder={
            searchPlaceholder ?? (onCreate ? "Search or create..." : "Search...")
          }
          value={search}
          onChange={handleSearchChange}
          onKeyDown={handleKeyDown}
          aria-activedescendant={highlightedId}
          aria-controls={LISTBOX_ID}
        />
        <div
          ref={listRef}
          className={styles.optionsList}
          style={{ maxHeight: listMaxHeight }}
          role="listbox"
          id={LISTBOX_ID}
        >
          {loading ? (
            <div className={styles.loading}>
              <Loader2 size={14} className={styles.spinner} />
              Loading...
            </div>
          ) : (
            <>
              {filtered.length === 0 && !createQuery && (
                <div className={styles.empty}>{emptyMessage}</div>
              )}
              {rows.map(renderRow)}
            </>
          )}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
