import React, { useId, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  completeClosedShortcode,
  findShortcodeQuery,
  loadEmojiIndex,
  replaceRange,
  searchEmoji,
  type EmojiEntry,
} from "../../../utils/emoji-shortcode";
import styles from "./EmojiAutocomplete.module.css";

type EmojiField = HTMLInputElement | HTMLTextAreaElement;

type ShortcodeMatch = { start: number; end: number; query: string };

type UseEmojiAutocompleteOptions = {
  /** When false the hook is inert: no listeners, no ARIA, no popover. */
  enabled?: boolean;
};

export type EmojiFieldProps<T extends EmojiField> = {
  onInput: (e: React.FormEvent<T>) => void;
  onSelect: (e: React.SyntheticEvent<T>) => void;
  onBlur: (e: React.FocusEvent<T>) => void;
  role?: "combobox";
  "aria-autocomplete"?: "list";
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
  "aria-activedescendant"?: string;
};

type PopoverVirtualRef = NonNullable<
  React.ComponentPropsWithoutRef<typeof Popover.Anchor>["virtualRef"]
>;

const noop = () => {};

/**
 * Write `next` into a React-managed input/textarea as if the user typed it.
 *
 * Assigning `el.value` directly is swallowed by React: its value tracker
 * records the new value, so the following `input` event looks like a no-op
 * and `onChange` never fires. Going through the prototype's native setter
 * bypasses the tracker, and the bubbling `input` event then reaches React's
 * root listener, which fires `onChange` with the new value. That keeps both
 * controlled (`setName(e.target.value)`) and uncontrolled / commit-on-blur
 * callers working without changes. This is the same trick React Testing
 * Library uses, and it is the one place ADR-174 depends on React internals.
 *
 * The caret is placed before dispatching so any handler reading
 * `selectionStart` during `onChange` sees the post-insert position.
 */
function writeFieldValue(el: EmojiField, next: string, caret: number) {
  const descriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(el),
    "value",
  );
  descriptor?.set?.call(el, next);
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Pick the shortcode worth showing for a row: the one the query matched. */
function displayShortcode(entry: EmojiEntry, query: string) {
  return (
    entry.shortcodes.find((code) => code.startsWith(query)) ??
    entry.shortcodes.find((code) => code.includes(query)) ??
    entry.shortcodes[0]
  );
}

function scrollIntoViewNearest(node: HTMLElement | null) {
  node?.scrollIntoView({ block: "nearest" });
}

/**
 * `:shortcode` emoji autocomplete for a text input or textarea (ADR-174).
 *
 * Wire it up by:
 * - calling `handleKeyDown(e)` first in the field's `onKeyDown`, and skipping
 *   your own key handling when it returns `true` (the list consumed the key);
 * - spreading `fieldProps` onto the field, composing `onInput`, `onSelect`
 *   and `onBlur` with your own handlers if you have them;
 * - rendering `suggestions` next to the field, so the portalled popover stays
 *   inside the same React tree (this matters inside Radix Dialogs).
 *
 * `EmojiInput` / `EmojiTextarea` do all of this for `ui/Input` / `ui/Textarea`.
 */
export function useEmojiAutocomplete<T extends EmojiField>(
  inputRef: React.RefObject<T | null>,
  options: UseEmojiAutocompleteOptions = {},
): {
  handleKeyDown: (e: React.KeyboardEvent<T>) => boolean;
  fieldProps: EmojiFieldProps<T>;
  suggestions: React.ReactNode;
} {
  const { enabled = true } = options;

  const [match, setMatch] = useState<ShortcodeMatch | null>(null);
  const [results, setResults] = useState<EmojiEntry[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [prevEnabled, setPrevEnabled] = useState(enabled);
  // Identity of the latest lookup. An index load that resolves after a newer
  // input/select event, a blur or a close compares unequal and is dropped.
  const requestRef = useRef<object | null>(null);
  // Set while `writeFieldValue` dispatches its synthetic `input` event, so
  // our own insertion never re-evaluates (and re-opens) the list.
  const writingRef = useRef(false);
  const id = useId();
  const listboxId = `${id}-emoji-listbox`;

  // Drop any open list when the hook is disabled (e.g. an inline rename ends)
  // so it does not reappear with stale results when re-enabled.
  if (enabled !== prevEnabled) {
    setPrevEnabled(enabled);
    if (!enabled) {
      requestRef.current = null;
      setMatch(null);
      setResults([]);
      setHighlight(0);
    }
  }

  const open = enabled && match !== null && results.length > 0;

  const close = () => {
    requestRef.current = null;
    setMatch(null);
    setResults([]);
    setHighlight(0);
  };

  const write = (el: T, next: string, caret: number) => {
    writingRef.current = true;
    try {
      writeFieldValue(el, next, caret);
    } finally {
      writingRef.current = false;
    }
    close();
  };

  const evaluate = async (allowClosingColon: boolean) => {
    const el = inputRef.current;
    if (!el || writingRef.current) return;

    const value = el.value;
    const caret = el.selectionStart;
    if (caret === null || caret !== el.selectionEnd) {
      close();
      return;
    }

    const next = findShortcodeQuery(value, caret);
    // A just-typed ':' closing an open query (`:tada:`) may complete in place.
    // It can never coexist with `next`, since ':' is not a query character.
    const closing =
      allowClosingColon &&
      value[caret - 1] === ":" &&
      findShortcodeQuery(value, caret - 1) !== null;
    if (!next && !closing) {
      close();
      return;
    }

    const token = {};
    requestRef.current = token;

    let index: EmojiEntry[];
    try {
      index = await loadEmojiIndex();
    } catch {
      if (requestRef.current === token) close();
      return;
    }
    if (requestRef.current !== token) return;

    if (!next) {
      const completed = completeClosedShortcode(value, caret, index);
      if (completed) write(el, completed.value, completed.caret);
      else close();
      return;
    }

    setMatch(next);
    setResults(searchEmoji(index, next.query));
    setHighlight(0);
  };

  const insert = (entry: EmojiEntry) => {
    const el = inputRef.current;
    if (!el) return;
    // Recompute the range from the live field rather than trusting `match`:
    // the user may have typed more while the index was loading.
    const caret = el.selectionStart ?? el.value.length;
    const range = findShortcodeQuery(el.value, caret);
    if (!range) {
      close();
      return;
    }
    const next = replaceRange(el.value, range.start, range.end, entry.emoji);
    write(el, next.value, next.caret);
  };

  const handleKeyDown = (e: React.KeyboardEvent<T>): boolean => {
    if (!open || e.nativeEvent.isComposing) return false;

    switch (e.key) {
      case "ArrowDown":
        setHighlight((i) => (i + 1) % results.length);
        break;
      case "ArrowUp":
        setHighlight((i) => (i <= 0 ? results.length - 1 : i - 1));
        break;
      case "Enter":
      case "Tab": {
        const entry = results[highlight] ?? results[0];
        insert(entry);
        break;
      }
      case "Escape":
        close();
        break;
      default:
        return false;
    }

    e.preventDefault();
    e.stopPropagation();
    return true;
  };

  if (!enabled) {
    return {
      handleKeyDown: () => false,
      fieldProps: { onInput: noop, onSelect: noop, onBlur: noop },
      suggestions: null,
    };
  }

  const optionId = (index: number) => `${listboxId}-option-${index}`;

  const fieldProps: EmojiFieldProps<T> = {
    onInput: () => void evaluate(true),
    onSelect: () => void evaluate(false),
    onBlur: close,
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-expanded": open,
    "aria-controls": open ? listboxId : undefined,
    "aria-activedescendant": open ? optionId(highlight) : undefined,
  };

  const suggestions = open ? (
    <Popover.Root
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
    >
      {/* The field is always mounted while the list is open, so `current` is
          non-null whenever Radix measures it. React 19's RefObject<T | null>
          does not overlap Radix's RefObject<Measurable>, hence the cast. */}
      <Popover.Anchor
        virtualRef={inputRef as unknown as PopoverVirtualRef}
      />
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          className={styles.content}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          // Escape belongs to `handleKeyDown`, which closes only the list and
          // stops the key reaching rename/dialog handlers. Without this,
          // Radix's document-level listener would dismiss first and the
          // field's handler could see the list already closed.
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <div className={styles.list} role="listbox" id={listboxId}>
            {results.map((entry, index) => (
              <div
                key={entry.emoji}
                ref={index === highlight ? scrollIntoViewNearest : undefined}
                id={optionId(index)}
                role="option"
                aria-selected={index === highlight}
                className={`${styles.option} ${index === highlight ? styles.optionHighlighted : ""}`}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(e) => {
                  // Keep focus in the field: no blur, so no rename commit.
                  e.preventDefault();
                  insert(entry);
                }}
              >
                <span className={styles.emoji}>{entry.emoji}</span>
                <span className={styles.shortcode}>
                  :{displayShortcode(entry, match?.query ?? "")}:
                </span>
              </div>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  ) : null;

  return { handleKeyDown, fieldProps, suggestions };
}
