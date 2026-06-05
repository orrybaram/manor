/**
 * TerminalSearchBar — floating cmd+f search for a terminal's scrollback.
 *
 * Drives the xterm SearchAddon: incremental find-as-you-type, Enter / Shift+Enter
 * to step through matches, Escape to close. Match decorations are derived from the
 * active terminal theme so highlights track the user's color scheme.
 */

import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { SearchAddon, ISearchOptions } from "@xterm/addon-search";
import Search from "lucide-react/dist/esm/icons/search";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import X from "lucide-react/dist/esm/icons/x";
import styles from "./TerminalPane.module.css";

type TerminalSearchBarProps = {
  term: Terminal;
  searchAddon: SearchAddon;
  /** Bumped each time cmd+f is pressed, so the input refocuses even when already open. */
  openNonce: number;
  onClose: () => void;
};

/** Build search options with match decorations pulled from the terminal theme. */
function searchOptions(term: Terminal): ISearchOptions {
  const theme = term.options.theme ?? {};
  const match = theme.yellow ?? "#b58900";
  const active = theme.brightYellow ?? "#ffd24a";
  return {
    incremental: true,
    decorations: {
      matchBackground: match,
      matchOverviewRuler: match,
      activeMatchBackground: active,
      activeMatchColorOverviewRuler: active,
    },
  };
}

export function TerminalSearchBar(props: TerminalSearchBarProps) {
  const { term, searchAddon, openNonce, onClose } = props;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ index: number; count: number }>({
    index: -1,
    count: 0,
  });
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus (and select) the input whenever cmd+f fires — including while open.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [openNonce]);

  // Track match counts for the "n/m" indicator.
  useEffect(() => {
    const sub = searchAddon.onDidChangeResults((e) => {
      setResults({ index: e.resultIndex, count: e.resultCount });
    });
    return () => sub.dispose();
  }, [searchAddon]);

  // Clear decorations/selection when the bar unmounts.
  useEffect(() => {
    return () => searchAddon.clearDecorations();
  }, [searchAddon]);

  const findNext = (value: string) => {
    if (value) searchAddon.findNext(value, searchOptions(term));
    else {
      searchAddon.clearDecorations();
      setResults({ index: -1, count: 0 });
    }
  };

  const findPrevious = (value: string) => {
    if (value) searchAddon.findPrevious(value, searchOptions(term));
  };

  const close = () => {
    searchAddon.clearDecorations();
    onClose();
    term.focus();
  };

  return (
    <div
      className={styles.searchBar}
      // Don't let key events bubble into the terminal's global handlers.
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Search size={12} className={styles.searchBarIcon} />
      <input
        ref={inputRef}
        className={styles.searchBarInput}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          findNext(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) findPrevious(query);
            else findNext(query);
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
        placeholder="Search terminal"
        spellCheck={false}
        autoFocus
      />
      {query && (
        <span className={styles.searchBarCount}>
          {results.count > 0 ? `${results.index + 1}/${results.count}` : "0/0"}
        </span>
      )}
      <button
        className={styles.searchBarButton}
        onClick={() => findPrevious(query)}
        title="Previous match (⇧⏎)"
        type="button"
      >
        <ChevronUp size={12} />
      </button>
      <button
        className={styles.searchBarButton}
        onClick={() => findNext(query)}
        title="Next match (⏎)"
        type="button"
      >
        <ChevronDown size={12} />
      </button>
      <button
        className={styles.searchBarButton}
        onClick={close}
        title="Close (Esc)"
        type="button"
      >
        <X size={12} />
      </button>
    </div>
  );
}
