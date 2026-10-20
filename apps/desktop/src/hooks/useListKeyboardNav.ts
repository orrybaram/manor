import { useCallback } from "react";

export function useListKeyboardNav(
  listLength: number,
  highlightIndex: number,
  setHighlightIndex: (updater: (i: number) => number) => void,
  onSelect: (index: number) => void,
) {
  return useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIndex((i) => Math.min(i + 1, listLength - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (highlightIndex >= 0 && highlightIndex < listLength) {
          onSelect(highlightIndex);
        }
      }
    },
    [listLength, highlightIndex, setHighlightIndex, onSelect],
  );
}
