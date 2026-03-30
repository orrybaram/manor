import React, { useState, useRef, useCallback, useMemo } from "react";
import * as Popover from "@radix-ui/react-popover";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import styles from "./SearchableSelect.module.css";

export type SearchableSelectOption = {
  value: string;
  label: string;
};

type SearchableSelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: SearchableSelectOption[];
  placeholder?: string;
  icon?: React.ReactNode;
  maxWidth?: number;
  loading?: boolean;
  emptyMessage?: string;
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
    loading = false,
    emptyMessage = "No results",
  } = props;

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedLabel = useMemo(() => {
    const found = options.find((o) => o.value === value);
    return found ? found.label : placeholder;
  }, [options, value, placeholder]);

  const filtered = useMemo(() => {
    if (!search) return options;
    const lower = search.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(lower));
  }, [options, search]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen) {
        setSearch("");
        setHighlightIndex(0);
      }
    },
    [],
  );

  const selectOption = useCallback(
    (optionValue: string) => {
      onChange(optionValue);
      setOpen(false);
      setSearch("");
      setHighlightIndex(0);
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (filtered.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIndex((prev) => (prev + 1) % filtered.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIndex((prev) =>
          prev <= 0 ? filtered.length - 1 : prev - 1,
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        const target = filtered[highlightIndex];
        if (target) {
          selectOption(target.value);
        }
      }
    },
    [filtered, highlightIndex, selectOption],
  );

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
      setHighlightIndex(0);
    },
    [],
  );

  const highlightedId =
    filtered.length > 0
      ? `searchable-select-option-${highlightIndex}`
      : undefined;

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <button
          className={styles.trigger}
          style={{ maxWidth }}
          role="combobox"
          aria-expanded={open}
          aria-controls={LISTBOX_ID}
        >
          {icon}
          <span className={styles.triggerText}>{selectedLabel}</span>
          <ChevronDown size={14} className={styles.chevron} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
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
            placeholder="Search..."
            value={search}
            onChange={handleSearchChange}
            onKeyDown={handleKeyDown}
            aria-activedescendant={highlightedId}
            aria-controls={LISTBOX_ID}
          />
          <div
            className={styles.optionsList}
            role="listbox"
            id={LISTBOX_ID}
          >
            {loading ? (
              <div className={styles.loading}>
                <Loader2 size={14} className={styles.spinner} />
                Loading...
              </div>
            ) : filtered.length === 0 ? (
              <div className={styles.empty}>{emptyMessage}</div>
            ) : (
              filtered.map((option, index) => (
                <div
                  key={option.value}
                  id={`searchable-select-option-${index}`}
                  role="option"
                  aria-selected={index === highlightIndex}
                  className={`${styles.option} ${index === highlightIndex ? styles.optionHighlighted : ""}`}
                  onMouseEnter={() => setHighlightIndex(index)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectOption(option.value);
                  }}
                >
                  {option.label}
                </div>
              ))
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
