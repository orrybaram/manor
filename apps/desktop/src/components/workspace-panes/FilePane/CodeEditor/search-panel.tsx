import { useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { EditorState } from "@codemirror/state";
import { runScopeHandlers, type EditorView, type Panel, type ViewUpdate } from "@codemirror/view";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  setSearchQuery,
} from "@codemirror/search";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import CaseSensitive from "lucide-react/dist/esm/icons/case-sensitive";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Regex from "lucide-react/dist/esm/icons/regex";
import Replace from "lucide-react/dist/esm/icons/replace";
import ReplaceAll from "lucide-react/dist/esm/icons/replace-all";
import WholeWord from "lucide-react/dist/esm/icons/whole-word";
import X from "lucide-react/dist/esm/icons/x";
import styles from "./SearchPanel.module.css";

/** Past this many matches the count reads "1000+" rather than walking a huge file. */
const MAX_COUNTED = 1000;

type Matches = { current: number; total: number } | "invalid" | null;

/** How many matches the query has, and which one the selection is on (1-based, 0 for none). */
function countMatches(state: EditorState): Matches {
  const query = getSearchQuery(state);
  if (!query.search) return null;
  if (!query.valid) return "invalid";
  const { from, to } = state.selection.main;
  const cursor = query.getCursor(state);
  let total = 0;
  let current = 0;
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total++;
    if (next.value.from === from && next.value.to === to) current = total;
    if (total >= MAX_COUNTED) break;
  }
  return { current, total };
}

function countLabel(matches: Matches): string {
  if (matches === "invalid") return "Invalid";
  if (!matches || matches.total === 0) return "No results";
  const total = matches.total >= MAX_COUNTED ? `${MAX_COUNTED}+` : `${matches.total}`;
  return matches.current ? `${matches.current} of ${total}` : `${total} found`;
}

type FindWidgetProps = {
  view: EditorView;
  query: SearchQuery;
  matches: Matches;
  readOnly: boolean;
};

/**
 * The file pane's find widget: a field with its case, word and regex
 * toggles, the match count, previous/next and close, and, in an editable
 * file, a replace row behind the chevron. It floats over the editor's top
 * right, the same as the terminal's search bar.
 */
function FindWidget({ view, query, matches, readOnly }: FindWidgetProps) {
  const [replaceOpen, setReplaceOpen] = useState(query.replace !== "");
  const [search, setSearch] = useState(query.search);
  const [replace, setReplace] = useState(query.replace);
  const replaceRef = useRef<HTMLInputElement>(null);

  // A query set from outside (⌘F over a selection) shows in the fields.
  const [shown, setShown] = useState(query);
  if (shown !== query) {
    setShown(query);
    setSearch(query.search);
    setReplace(query.replace);
  }

  const commit = (change: Partial<ConstructorParameters<typeof SearchQuery>[0]>) => {
    const next = new SearchQuery({
      search: query.search,
      caseSensitive: query.caseSensitive,
      regexp: query.regexp,
      wholeWord: query.wholeWord,
      replace: query.replace,
      ...change,
    });
    if (!next.eq(query)) view.dispatch({ effects: setSearchQuery.of(next) });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // ⌘F, ⌘G and Escape, as the editor binds them for its search panel.
    if (runScopeHandlers(view, e.nativeEvent, "search-panel")) {
      e.preventDefault();
      return;
    }
    if (e.key !== "Enter") return;
    const target = e.target as HTMLElement;
    if (target.getAttribute("name") === "search") {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(view);
    } else if (target.getAttribute("name") === "replace") {
      e.preventDefault();
      (e.metaKey || e.ctrlKey ? replaceAll : replaceNext)(view);
    }
  };

  const toggle = (
    label: string,
    on: boolean,
    Icon: typeof CaseSensitive,
    flip: () => void,
  ) => (
    <button
      type="button"
      className={styles.toggle}
      aria-pressed={on}
      aria-label={label}
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={flip}
    >
      <Icon size={14} />
    </button>
  );

  const showReplace = replaceOpen && !readOnly;
  const empty = matches === null || matches === "invalid" || matches.total === 0;

  return (
    <div className={styles.widget} data-testid="file-pane-find" onKeyDown={onKeyDown}>
      {!readOnly && (
        <button
          type="button"
          className={styles.expand}
          aria-expanded={showReplace}
          aria-label="Toggle Replace"
          title="Toggle Replace"
          onClick={() => {
            setReplaceOpen(!replaceOpen);
            if (!replaceOpen) requestAnimationFrame(() => replaceRef.current?.focus());
          }}
        >
          <ChevronRight size={14} className={styles.expandIcon} />
        </button>
      )}
      <div className={styles.rows}>
        <div className={styles.row}>
          <div className={styles.field} data-invalid={matches === "invalid" || undefined}>
            <input
              className={styles.input}
              name="search"
              main-field="true"
              aria-label="Find"
              placeholder="Find"
              spellCheck={false}
              autoComplete="off"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                commit({ search: e.target.value });
              }}
            />
            <div className={styles.toggles}>
              {toggle("Match Case", query.caseSensitive, CaseSensitive, () =>
                commit({ caseSensitive: !query.caseSensitive }),
              )}
              {toggle("Match Whole Word", query.wholeWord, WholeWord, () =>
                commit({ wholeWord: !query.wholeWord }),
              )}
              {toggle("Use Regular Expression", query.regexp, Regex, () =>
                commit({ regexp: !query.regexp }),
              )}
            </div>
          </div>
          <span
            className={styles.count}
            data-testid="file-pane-find-count"
            data-empty={(query.search !== "" && empty) || undefined}
          >
            {query.search ? countLabel(matches) : ""}
          </span>
          <button
            type="button"
            className={styles.button}
            aria-label="Previous Match"
            title="Previous Match (⇧⏎)"
            disabled={empty}
            onClick={() => findPrevious(view)}
          >
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            className={styles.button}
            aria-label="Next Match"
            title="Next Match (⏎)"
            disabled={empty}
            onClick={() => findNext(view)}
          >
            <ArrowDown size={14} />
          </button>
          <button
            type="button"
            className={styles.button}
            aria-label="Close"
            title="Close (Esc)"
            onClick={() => closeSearchPanel(view)}
          >
            <X size={14} />
          </button>
        </div>
        {showReplace && (
          <div className={styles.row}>
            <div className={styles.field}>
              <input
                ref={replaceRef}
                className={styles.input}
                name="replace"
                aria-label="Replace"
                placeholder="Replace"
                spellCheck={false}
                autoComplete="off"
                value={replace}
                onChange={(e) => {
                  setReplace(e.target.value);
                  commit({ replace: e.target.value });
                }}
              />
            </div>
            <button
              type="button"
              className={styles.button}
              aria-label="Replace"
              title="Replace (⏎)"
              disabled={empty}
              onClick={() => replaceNext(view)}
            >
              <Replace size={14} />
            </button>
            <button
              type="button"
              className={styles.button}
              aria-label="Replace All"
              title="Replace All (⌘⏎)"
              disabled={empty}
              onClick={() => replaceAll(view)}
            >
              <ReplaceAll size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** `search({ createPanel })`'s panel: the find widget in its own React root. */
class FindPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  private readonly root: Root;
  private matches: Matches;

  constructor(private readonly view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "cm-search";
    this.root = createRoot(this.dom);
    this.matches = countMatches(view.state);
    // Rendered now, so the field is there for `mount` and openSearchPanel to focus.
    flushSync(() => this.render());
  }

  private render() {
    this.root.render(
      <FindWidget
        view={this.view}
        query={getSearchQuery(this.view.state)}
        matches={this.matches}
        readOnly={this.view.state.readOnly}
      />,
    );
  }

  mount() {
    this.dom.querySelector<HTMLInputElement>("[main-field]")?.select();
  }

  update(update: ViewUpdate) {
    const queryChanged = getSearchQuery(update.state) !== getSearchQuery(update.startState);
    const readOnlyChanged = update.state.readOnly !== update.startState.readOnly;
    if (!queryChanged && !readOnlyChanged && !update.docChanged && !update.selectionSet) return;
    this.matches = countMatches(update.state);
    this.render();
  }

  destroy() {
    const root = this.root;
    setTimeout(() => root.unmount());
  }
}

export const createFindPanel = (view: EditorView): Panel => new FindPanel(view);
