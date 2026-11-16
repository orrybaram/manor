import { useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import ListX from "lucide-react/dist/esm/icons/list-x";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import type { FileSearchParams, FileSearchResult } from "../../../../electron.d";
import { ipcErrorMessage } from "../../../../lib/ipc-error";
import { useMountEffect } from "../../../../hooks/useMountEffect";
import { Tooltip } from "../../../ui/Tooltip/Tooltip";
import type { FilesWorkspace } from "../open-file-watches";
import {
  paneSearch,
  searchParams,
  useFileSearchState,
  type SearchForm,
} from "../search-state";
import {
  highlightSegments,
  resultSummary,
  searchRows,
  stepSearchRow,
  type SearchRow,
} from "../search-results";
import styles from "./SearchView.module.css";

/** How long typing settles before a search runs. */
const DEBOUNCE_MS = 250;

/** The query key every search of `workspace` shares, for Refresh. */
function searchKey(workspace: FilesWorkspace): unknown[] {
  return ["files.search", workspace.hostId, workspace.path];
}

/** The Search view's header buttons: run the search again, and clear it. */
export function SearchHeadActions({
  paneId,
  workspace,
}: {
  paneId: string;
  workspace: FilesWorkspace;
}) {
  const queryClient = useQueryClient();
  return (
    <>
      <Tooltip label="Refresh">
        <button
          type="button"
          className={styles.headBtn}
          aria-label="Refresh"
          data-testid="file-search-refresh"
          onClick={() => void queryClient.invalidateQueries({ queryKey: searchKey(workspace) })}
        >
          <RefreshCw size={12} />
        </button>
      </Tooltip>
      <Tooltip label="Clear search results">
        <button
          type="button"
          className={styles.headBtn}
          aria-label="Clear search results"
          data-testid="file-search-clear"
          onClick={() => useFileSearchState.getState().clear(paneId)}
        >
          <ListX size={13} />
        </button>
      </Tooltip>
    </>
  );
}

/**
 * The drawer's Search view: a query with Case, Word and Regex toggles, globs
 * to include and exclude, and the workspace's matches grouped by file. Typing
 * runs `files.search` once it settles; only the answer to the newest search
 * shows. What it holds lives in `useFileSearchState`, by pane, so it is the
 * same after switching views or a remount; a search asked from outside
 * (`requestSearch`) runs at once.
 */
export function SearchView({
  paneId,
  workspace,
  onOpen,
}: {
  paneId: string;
  workspace: FilesWorkspace;
  /** Open `path` with the cursor at `line`:`col` (1-based). */
  onOpen: (path: string, line: number, col: number) => void;
}) {
  const pane = useFileSearchState((s) => paneSearch(s.byPane, paneId));
  const { form } = pane;
  // The search that runs: the form as it last settled, or as last asked for.
  const [ran, setRan] = useState<{ asked: number; params: FileSearchParams }>(() => ({
    asked: pane.asked,
    params: searchParams(form),
  }));
  if (ran.asked !== pane.asked) setRan({ asked: pane.asked, params: searchParams(form) });

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useMountEffect(() => () => clearTimeout(timer.current));
  const settle = () => {
    clearTimeout(timer.current);
    const now = paneSearch(useFileSearchState.getState().byPane, paneId);
    setRan({ asked: now.asked, params: searchParams(now.form) });
  };
  const edit = (patch: Partial<SearchForm>, at: "now" | "settled" = "settled") => {
    useFileSearchState.getState().edit(paneId, patch);
    clearTimeout(timer.current);
    if (at === "now") settle();
    else timer.current = setTimeout(settle, DEBOUNCE_MS);
  };

  const enabled = ran.params.query !== "";
  const result = useQuery({
    // `asked`: the same search asked again runs again.
    queryKey: [...searchKey(workspace), ran.params, ran.asked],
    queryFn: () => window.electronAPI.files.search(workspace, ran.params),
    enabled,
    staleTime: 0,
    // A lost host throws; say so at once rather than after the retries.
    retry: false,
    placeholderData: keepPreviousData,
  });
  const answer = enabled ? result.data : undefined;
  const files = answer?.ok ? answer.files : null;

  const collapsed = useMemo(() => new Set(pane.collapsed), [pane.collapsed]);
  const rows = useMemo(() => (files ? searchRows(files, collapsed) : []), [files, collapsed]);
  const [cursor, setCursor] = useState<string | null>(null);
  const cursorAt = cursor === null ? -1 : rows.findIndex((r) => r.key === cursor);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const toggleFile = (path: string, fold?: boolean) => {
    const next = new Set(collapsed);
    const folding = fold ?? !next.has(path);
    if (folding) next.add(path);
    else next.delete(path);
    useFileSearchState.getState().setCollapsed(paneId, [...next]);
  };

  const moveTo = (index: number) => {
    if (index < 0) {
      setCursor(null);
      inputRef.current?.focus();
      return;
    }
    setCursor(rows[index].key);
    listRef.current
      ?.querySelector(`[data-row="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  const openRow = (row: SearchRow) => {
    setCursor(row.key);
    if (row.kind === "file") toggleFile(row.path);
    else onOpen(row.path, row.match.line, row.match.col);
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const row = cursorAt >= 0 ? rows[cursorAt] : null;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      moveTo(stepSearchRow(rows, row?.key ?? null, e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter" && row) {
      e.preventDefault();
      openRow(row);
    } else if (e.key === "ArrowLeft" && row) {
      e.preventDefault();
      if (row.kind === "file") toggleFile(row.path, true);
      else moveTo(rows.findIndex((r) => r.kind === "file" && r.path === row.path));
    } else if (e.key === "ArrowRight" && row?.kind === "file") {
      e.preventDefault();
      toggleFile(row.path, false);
    }
  };

  const status = summaryOf(enabled, result.isError ? result.error : null, answer);

  return (
    <div className={styles.view} data-testid="file-search-view">
      <div className={styles.fields}>
        <div className={styles.field}>
          <input
            ref={inputRef}
            className={styles.input}
            data-testid="file-search-input"
            aria-label="Search"
            placeholder="Search"
            value={form.query}
            spellCheck={false}
            onChange={(e) => edit({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                settle();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                const index = stepSearchRow(rows, null, 1);
                if (index < 0) return;
                moveTo(index);
                listRef.current?.focus({ preventScroll: true });
              }
            }}
          />
          <Toggle
            label="Match Case"
            text="Aa"
            testId="file-search-case"
            on={form.caseSensitive}
            onChange={(on) => edit({ caseSensitive: on }, "now")}
          />
          <Toggle
            label="Match Whole Word"
            text="ab"
            testId="file-search-word"
            on={form.wholeWord}
            onChange={(on) => edit({ wholeWord: on }, "now")}
          />
          <Toggle
            label="Use Regular Expression"
            text=".*"
            testId="file-search-regex"
            on={form.regex}
            onChange={(on) => edit({ regex: on }, "now")}
          />
        </div>
        <div className={styles.field}>
          <input
            className={styles.input}
            data-testid="file-search-include"
            aria-label="Files to include"
            placeholder="files to include"
            value={form.include}
            spellCheck={false}
            onChange={(e) => edit({ include: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") settle();
            }}
          />
        </div>
        <div className={styles.field}>
          <input
            className={styles.input}
            data-testid="file-search-exclude"
            aria-label="Files to exclude"
            placeholder="files to exclude"
            value={form.exclude}
            spellCheck={false}
            onChange={(e) => edit({ exclude: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") settle();
            }}
          />
        </div>
      </div>
      {(pane.label !== null || status !== null) && (
        <div className={styles.summary} role="status">
          {pane.label !== null && (
            <span className={styles.pill} data-testid="file-search-label">
              {pane.label}
            </span>
          )}
          {status !== null && (
            <span
              className={status.error ? styles.error : styles.meta}
              data-testid="file-search-summary"
            >
              {status.text}
            </span>
          )}
        </div>
      )}
      {rows.length > 0 && (
        <div
          ref={listRef}
          className={styles.results}
          data-testid="file-search-results"
          aria-label="Search results"
          tabIndex={0}
          onKeyDown={onListKey}
          onFocus={(e) => {
            // A clicked row hands the keyboard back to the list.
            if (e.target !== e.currentTarget) e.currentTarget.focus({ preventScroll: true });
          }}
        >
          {rows.map((row, index) =>
            row.kind === "file" ? (
              <button
                key={row.key}
                type="button"
                tabIndex={-1}
                className={`${styles.fileRow} ${index === cursorAt ? styles.cursor : ""}`}
                data-testid="file-search-file"
                data-row={index}
                data-path={row.path}
                aria-expanded={!row.collapsed}
                title={row.path}
                onClick={() => openRow(row)}
              >
                {row.collapsed ? (
                  <ChevronRight size={12} className={styles.chevron} />
                ) : (
                  <ChevronDown size={12} className={styles.chevron} />
                )}
                <span className={styles.fileName}>{row.name}</span>
                <span className={styles.dir}>{row.dir}</span>
                <span className={styles.count} data-testid="file-search-count">
                  {row.count}
                </span>
              </button>
            ) : (
              <button
                key={row.key}
                type="button"
                tabIndex={-1}
                className={`${styles.matchRow} ${index === cursorAt ? styles.cursor : ""}`}
                data-testid="file-search-match"
                data-row={index}
                data-path={row.path}
                data-line={row.match.line}
                aria-selected={index === cursorAt}
                title={`${row.path}:${row.match.line}`}
                onClick={() => openRow(row)}
              >
                {highlightSegments(row.match.text, row.match.ranges).map((seg, i) =>
                  seg.match ? (
                    <mark key={i} className={styles.mark}>
                      {seg.text}
                    </mark>
                  ) : (
                    <span key={i}>{seg.text}</span>
                  ),
                )}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function Toggle({
  label,
  text,
  testId,
  on,
  onChange,
}: {
  label: string;
  text: string;
  testId: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        className={`${styles.toggle} ${on ? styles.toggleOn : ""}`}
        aria-label={label}
        aria-pressed={on}
        data-testid={testId}
        onClick={() => onChange(!on)}
      >
        {text}
      </button>
    </Tooltip>
  );
}

type Status = { text: string; error: boolean };

/** The summary line: counts, a cap note, or why the search didn't run. */
function summaryOf(
  enabled: boolean,
  thrown: unknown,
  answer: FileSearchResult | undefined,
): Status | null {
  if (!enabled) return null;
  if (thrown) return { text: ipcErrorMessage(thrown), error: true };
  if (!answer) return { text: "Searching…", error: false };
  if (!answer.ok) return { text: answer.message, error: true };
  const text = resultSummary(answer.total, answer.files.length);
  return { text: answer.truncated ? `${text} (truncated)` : text, error: false };
}
