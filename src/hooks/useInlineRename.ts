import { useRef, useState } from "react";
import { useEmojiAutocomplete } from "../components/ui/EmojiAutocomplete/useEmojiAutocomplete";

type InlineRenameOptions = {
  /** Enable `:shortcode` emoji autocomplete while editing (ADR-174). */
  emoji?: boolean;
};

/**
 * Inline text-edit state for a rename affordance (double-click / context menu).
 * Mirrors the folder-rename pattern in the sidebar: focus + select on start,
 * commit on Enter or blur, cancel on Escape. An empty commit is passed through
 * so callers can treat it as "clear the custom name".
 *
 * Two focus subtleties are handled here so callers do not have to:
 *
 * - Escape cancels and then blurs the input, and the blur handler must not
 *   turn around and commit. React state is not updated yet when that blur
 *   fires, so "am I editing" lives in a ref as well as in state.
 * - A rename started from a Radix context menu races the menu's own focus
 *   restore: on close it puts focus back on the trigger, which blurs the
 *   input we just focused and ends the edit before it began. Spread
 *   `menuContentProps` onto the `ContextMenu.Content` to opt out of that
 *   restore only while an edit is in progress.
 *
 * With `{ emoji: true }`, `inputProps` also carries `:shortcode` emoji
 * autocomplete. While its suggestion list is open, it takes Arrow keys,
 * Enter/Tab (insert) and Escape (close the list only) before the
 * commit/cancel handling. Render the returned `suggestions` next to the
 * input. It is `null` when emoji is off or nothing is being edited.
 */
export function useInlineRename(
  current: string,
  onCommit: (next: string) => void,
  options: InlineRenameOptions = {},
) {
  const { emoji = false } = options;

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(current);
  const inputRef = useRef<HTMLInputElement>(null);
  const editingRef = useRef(false);
  const autocomplete = useEmojiAutocomplete(inputRef, {
    enabled: editing && emoji,
  });

  const start = () => {
    editingRef.current = true;
    setValue(current);
    setEditing(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  };

  const commit = () => {
    if (!editingRef.current) return;
    editingRef.current = false;
    setEditing(false);
    const trimmed = value.trim();
    if (trimmed !== current) onCommit(trimmed);
  };

  const cancel = () => {
    editingRef.current = false;
    setEditing(false);
  };

  const inputProps = {
    ...autocomplete.fieldProps,
    ref: inputRef,
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value),
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
      autocomplete.fieldProps.onBlur(e);
      commit();
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (autocomplete.handleKeyDown(e)) {
        e.stopPropagation();
        return;
      }
      if (e.key === "Enter") commit();
      if (e.key === "Escape") {
        cancel();
        e.currentTarget.blur();
      }
      e.stopPropagation();
    },
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  };

  const menuContentProps = {
    onCloseAutoFocus: (e: Event) => {
      if (editingRef.current) e.preventDefault();
    },
  };

  return {
    editing,
    start,
    inputProps,
    menuContentProps,
    suggestions: autocomplete.suggestions,
  };
}
