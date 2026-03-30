import { createElement, useEffect, useState, useMemo, useCallback, useRef } from "react";
import type { ReactNode } from "react";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up";
import X from "lucide-react/dist/esm/icons/x";
import type { RootContent, Element as HastElement } from "hast";
import { useProjectStore } from "../../../store/project-store";
import { extToLang, tokenize } from "./syntax";
import styles from "./DiffPane.module.css";

// ── Parser ──

interface DiffLine {
  type: "context" | "add" | "del" | "hunk";
  content: string;
  oldNum?: number;
  newNum?: number;
}

interface DiffFile {
  path: string;
  lines: DiffLine[];
  added: number;
  removed: number;
}

function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = raw.split("\n");
  let current: DiffFile | null = null;
  let oldNum = 0;
  let newNum = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git")) {
      // Extract path from "diff --git a/foo b/foo"
      const match = line.match(/^diff --git a\/.+ b\/(.+)$/);
      current = { path: match?.[1] ?? "unknown", lines: [], added: 0, removed: 0 };
      files.push(current);
      continue;
    }

    if (!current) continue;

    // Skip index/--- /+++ metadata lines
    if (line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("Binary files")) {
      current.lines.push({ type: "context", content: line });
      continue;
    }

    // Hunk header
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunkMatch) {
      oldNum = parseInt(hunkMatch[1], 10);
      newNum = parseInt(hunkMatch[2], 10);
      current.lines.push({ type: "hunk", content: `@@ -${hunkMatch[1]} +${hunkMatch[2]} @@${hunkMatch[3]}` });
      continue;
    }

    if (line.startsWith("+")) {
      current.lines.push({ type: "add", content: line.slice(1), newNum });
      current.added++;
      newNum++;
    } else if (line.startsWith("-")) {
      current.lines.push({ type: "del", content: line.slice(1), oldNum });
      current.removed++;
      oldNum++;
    } else if (line.startsWith(" ") || line === "") {
      current.lines.push({ type: "context", content: line.slice(1), oldNum, newNum });
      oldNum++;
      newNum++;
    }
  }

  return files;
}

// ── Search helpers ──

function highlightText(
  text: string,
  query: string,
  startIndex: number,
  currentMatch: number,
): { fragments: React.ReactNode[]; matchCount: number } {
  if (!query) return { fragments: [text], matchCount: 0 };

  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  const fragments: React.ReactNode[] = [];
  let last = 0;
  let matchCount = 0;

  let pos = lower.indexOf(qLower);
  while (pos !== -1) {
    if (pos > last) fragments.push(text.slice(last, pos));
    const globalIdx = startIndex + matchCount;
    fragments.push(
      <mark
        key={pos}
        className={globalIdx === currentMatch ? styles.searchMatchActive : styles.searchMatch}
        data-match-index={globalIdx}
      >
        {text.slice(pos, pos + query.length)}
      </mark>,
    );
    matchCount++;
    last = pos + query.length;
    pos = lower.indexOf(qLower, last);
  }

  if (last < text.length) fragments.push(text.slice(last));
  return { fragments, matchCount };
}

function countMatches(text: string, query: string): number {
  if (!query) return 0;
  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  let count = 0;
  let pos = lower.indexOf(qLower);
  while (pos !== -1) {
    count++;
    pos = lower.indexOf(qLower, pos + qLower.length);
  }
  return count;
}

// ── HAST → React helpers ──

function hastToReact(nodes: RootContent[], keyPrefix = ""): ReactNode[] {
  return nodes.map((node, i) => {
    if (node.type === "text") {
      return node.value;
    }
    if (node.type === "element") {
      const el = node as HastElement;
      const className = Array.isArray(el.properties?.className)
        ? (el.properties.className as string[]).join(" ")
        : undefined;
      return createElement(
        el.tagName,
        { key: `${keyPrefix}-${i}`, className },
        ...hastToReact(el.children as RootContent[], `${keyPrefix}-${i}`),
      );
    }
    return null;
  });
}

/**
 * Apply search highlighting on top of syntax-highlighted HAST nodes.
 * Walks through every text segment, splitting at match boundaries to
 * insert <mark> elements while preserving the surrounding syntax spans.
 */
function highlightSyntaxNodes(
  nodes: RootContent[],
  query: string,
  startIndex: number,
  currentMatch: number,
  keyPrefix = "",
): { elements: ReactNode[]; matchCount: number } {
  if (!query) {
    return { elements: hastToReact(nodes, keyPrefix), matchCount: 0 };
  }

  const qLower = query.toLowerCase();
  let globalIdx = startIndex;

  function walkNodes(items: RootContent[], kp: string): ReactNode[] {
    const result: ReactNode[] = [];
    for (let i = 0; i < items.length; i++) {
      const node = items[i];
      if (node.type === "text") {
        const text = node.value;
        const lower = text.toLowerCase();
        let last = 0;
        let pos = lower.indexOf(qLower);
        const frags: ReactNode[] = [];

        while (pos !== -1) {
          if (pos > last) frags.push(text.slice(last, pos));
          frags.push(
            createElement(
              "mark",
              {
                key: `${kp}-m-${pos}`,
                className: globalIdx === currentMatch ? styles.searchMatchActive : styles.searchMatch,
                "data-match-index": globalIdx,
              },
              text.slice(pos, pos + query.length),
            ),
          );
          globalIdx++;
          last = pos + query.length;
          pos = lower.indexOf(qLower, last);
        }

        if (last < text.length) frags.push(text.slice(last));
        if (frags.length > 0) {
          result.push(...frags);
        } else {
          result.push(text);
        }
      } else if (node.type === "element") {
        const el = node as HastElement;
        const className = Array.isArray(el.properties?.className)
          ? (el.properties.className as string[]).join(" ")
          : undefined;
        const children = walkNodes(el.children as RootContent[], `${kp}-${i}`);
        result.push(
          createElement(el.tagName, { key: `${kp}-${i}`, className }, ...children),
        );
      }
    }
    return result;
  }

  const elements = walkNodes(nodes, keyPrefix);
  return { elements, matchCount: globalIdx - startIndex };
}

function SearchBar({
  query,
  onChange,
  totalMatches,
  currentMatch,
  onNext,
  onPrev,
  onClose,
}: {
  query: string;
  onChange: (q: string) => void;
  totalMatches: number;
  currentMatch: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "Enter") {
      if (e.shiftKey) onPrev();
      else onNext();
    }
  };

  return (
    <div className={styles.searchBar}>
      <input
        ref={inputRef}
        className={styles.searchInput}
        type="text"
        placeholder="Find..."
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <span className={styles.searchCount}>
        {query ? `${totalMatches > 0 ? currentMatch + 1 : 0} of ${totalMatches}` : ""}
      </span>
      <button className={styles.searchBtn} onClick={onPrev} disabled={totalMatches === 0} aria-label="Previous match">
        <ChevronUp size={14} />
      </button>
      <button className={styles.searchBtn} onClick={onNext} disabled={totalMatches === 0} aria-label="Next match">
        <ChevronDown size={14} />
      </button>
      <button className={styles.searchBtn} onClick={onClose} aria-label="Close search">
        <X size={14} />
      </button>
    </div>
  );
}

// ── Components ──

function FileHeader({ file, collapsed, onToggle }: { file: DiffFile; collapsed: boolean; onToggle: () => void }) {
  return (
    <div className={styles.fileHeader} onClick={onToggle}>
      <span className={`${styles.chevron} ${collapsed ? "" : styles.chevronOpen}`}>
        <ChevronRight size={12} />
      </span>
      <span className={styles.fileName}>{file.path}</span>
      <span className={styles.fileStats}>
        {file.added > 0 && <span className={styles.statAdded}>+{file.added}</span>}
        {file.removed > 0 && <span className={styles.statRemoved}>-{file.removed}</span>}
      </span>
    </div>
  );
}

function DiffLines({ lines, filePath, searchQuery, matchOffset, currentMatch }: {
  lines: DiffLine[];
  filePath: string;
  searchQuery: string;
  matchOffset: number;
  currentMatch: number;
}) {
  // Memoize tokenization based on lines and filePath
  const tokenizedLines = useMemo(() => {
    const lang = extToLang(filePath);
    if (!lang) return null;
    return lines.map((line) => {
      if (line.type === "hunk") return null;
      return tokenize(line.content, lang);
    });
  }, [lines, filePath]);

  let runningOffset = matchOffset;

  return (
    <table className={styles.table}>
      <tbody>
        {lines.map((line, i) => {
          if (line.type === "hunk") {
            return (
              <tr key={i} className={styles.hunkRow}>
                <td className={styles.lineNum} />
                <td className={styles.hunkContent}>{line.content}</td>
              </tr>
            );
          }
          const rowClass =
            line.type === "add" ? styles.lineAdd :
            line.type === "del" ? styles.lineDel :
            undefined;
          const numClass =
            line.type === "add" ? styles.lineNumAdd :
            line.type === "del" ? styles.lineNumDel :
            styles.lineNum;
          const num = line.type === "del" ? line.oldNum : line.newNum;
          const prefix =
            line.type === "add" ? "+" :
            line.type === "del" ? "-" :
            " ";

          let content: ReactNode[];
          let matchCount: number;

          const tokens = tokenizedLines?.[i];
          if (tokens) {
            // Syntax highlighting with search overlay
            const result = highlightSyntaxNodes(tokens, searchQuery, runningOffset, currentMatch, `l${i}`);
            content = result.elements;
            matchCount = result.matchCount;
          } else {
            // Fallback: plain text with search highlighting
            const result = highlightText(line.content, searchQuery, runningOffset, currentMatch);
            content = result.fragments;
            matchCount = result.matchCount;
          }

          runningOffset += matchCount;

          return (
            <tr key={i} className={rowClass}>
              <td className={numClass}>{num}</td>
              <td className={styles.lineContent}>
                <span className={styles.prefix}>{prefix}</span>
                {content}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function FileList({ files, onSelectFile }: { files: DiffFile[]; onSelectFile: (path: string) => void }) {
  const totalAdded = files.reduce((s, f) => s + f.added, 0);
  const totalRemoved = files.reduce((s, f) => s + f.removed, 0);

  return (
    <div className={styles.fileList}>
      <div className={styles.fileListHeader}>
        {files.length} {files.length === 1 ? "file" : "files"} changed
        {totalAdded > 0 && <span className={styles.statAdded}> +{totalAdded}</span>}
        {totalRemoved > 0 && <span className={styles.statRemoved}> -{totalRemoved}</span>}
      </div>
      {files.map((file) => (
        <div key={file.path} className={styles.fileListItem} onClick={() => onSelectFile(file.path)}>
          <span className={styles.fileListName}>{file.path}</span>
          <span className={styles.fileStats}>
            {file.added > 0 && <span className={styles.statAdded}>+{file.added}</span>}
            {file.removed > 0 && <span className={styles.statRemoved}>-{file.removed}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Main ──

type DiffPaneProps = {
  workspacePath?: string;
};

export function DiffPane({ workspacePath }: DiffPaneProps) {
  const [raw, setRaw] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentMatch, setCurrentMatch] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (el) setShowBackToTop(el.scrollTop > 300);
  }, []);

  const scrollToTop = useCallback(() => {
    containerRef.current?.scrollTo({ top: 0 });
  }, []);

  const toggleFile = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const scrollToFile = useCallback((path: string) => {
    // Expand if collapsed
    setCollapsed((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    // Scroll after render
    requestAnimationFrame(() => {
      fileRefs.current.get(path)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);

  // Cmd+F to open search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        // Only capture if this pane (or its children) has focus
        if (!containerRef.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const project = useProjectStore((s) =>
    s.projects.find((p) =>
      p.workspaces.some((ws) => ws.path === workspacePath),
    ),
  );
  const defaultBranch = project?.defaultBranch ?? "main";

  useEffect(() => {
    if (!workspacePath) return;

    let cancelled = false;

    const fetchDiff = () => {
      window.electronAPI.diffs
        .getFullDiff(workspacePath, defaultBranch)
        .then((result) => {
          if (cancelled) return;
          if (!result || result.trim() === "") {
            setRaw(null);
            setError("No changes found");
          } else {
            setRaw(result);
            setError(null);
          }
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : "Failed to load diff");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    setLoading(true);
    setError(null);
    fetchDiff();

    const timer = setInterval(fetchDiff, 5000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [workspacePath, defaultBranch]);

  const files = useMemo(() => (raw ? parseDiff(raw) : []), [raw]);

  // Compute per-file match offsets and total
  const { fileOffsets, totalMatches } = useMemo(() => {
    if (!searchQuery) return { fileOffsets: new Map<string, number>(), totalMatches: 0 };
    let total = 0;
    const offsets = new Map<string, number>();
    for (const file of files) {
      if (collapsed.has(file.path)) {
        offsets.set(file.path, total);
        continue;
      }
      offsets.set(file.path, total);
      for (const line of file.lines) {
        if (line.type === "hunk") continue;
        total += countMatches(line.content, searchQuery);
      }
    }
    return { fileOffsets: offsets, totalMatches: total };
  }, [files, searchQuery, collapsed]);

  // Reset current match when query or total changes
  useEffect(() => {
    setCurrentMatch(0);
  }, [searchQuery, totalMatches]);

  // Scroll active match into view
  useEffect(() => {
    if (!searchQuery || totalMatches === 0) return;
    requestAnimationFrame(() => {
      const el = containerRef.current?.querySelector(`[data-match-index="${currentMatch}"]`);
      el?.scrollIntoView({ block: "center" });
    });
  }, [currentMatch, searchQuery, totalMatches]);

  const handleSearchNext = useCallback(() => {
    setCurrentMatch((prev) => (prev + 1) % totalMatches);
  }, [totalMatches]);

  const handleSearchPrev = useCallback(() => {
    setCurrentMatch((prev) => (prev - 1 + totalMatches) % totalMatches);
  }, [totalMatches]);

  const handleSearchClose = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.status}>Loading diff...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.status}>{error}</div>
      </div>
    );
  }

  return (
    <div className={styles.container} ref={containerRef} onScroll={handleScroll}>
      {searchOpen && (
        <SearchBar
          query={searchQuery}
          onChange={setSearchQuery}
          totalMatches={totalMatches}
          currentMatch={currentMatch}
          onNext={handleSearchNext}
          onPrev={handleSearchPrev}
          onClose={handleSearchClose}
        />
      )}
      <FileList files={files} onSelectFile={scrollToFile} />
      {files.map((file) => (
        <div
          key={file.path}
          className={styles.file}
          ref={(el) => { if (el) fileRefs.current.set(file.path, el); else fileRefs.current.delete(file.path); }}
          onCopy={(e) => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed) return;

            e.preventDefault();

            // Walk selected table rows to extract line numbers + content
            const range = sel.getRangeAt(0);
            const ancestor = range.commonAncestorContainer instanceof HTMLElement
              ? range.commonAncestorContainer
              : range.commonAncestorContainer.parentElement;
            const table = ancestor?.closest("table") ?? ancestor?.querySelector("table");
            const rows = table?.querySelectorAll("tr");

            const lines: string[] = [];
            if (rows) {
              for (const row of rows) {
                if (!sel.containsNode(row, true)) continue;
                const numCell = row.querySelector("td:first-child");
                const contentCell = row.querySelector("td:last-child");
                if (!contentCell) continue;
                const num = numCell?.textContent?.trim() ?? "";
                const content = contentCell?.textContent ?? "";
                lines.push(num ? `${num}: ${content}` : content);
              }
            }

            const body = lines.length > 0 ? lines.join("\n") : sel.toString();
            e.clipboardData.setData("text/plain", `${file.path}\n${body}`);
          }}
        >
          <FileHeader file={file} collapsed={collapsed.has(file.path)} onToggle={() => toggleFile(file.path)} />
          {!collapsed.has(file.path) && (
            <DiffLines
              lines={file.lines}
              filePath={file.path}
              searchQuery={searchQuery}
              matchOffset={fileOffsets.get(file.path) ?? 0}
              currentMatch={currentMatch}
            />
          )}
        </div>
      ))}
      {showBackToTop && (
        <button className={styles.backToTop} onClick={scrollToTop} aria-label="Back to top">
          <ArrowUp size={14} />
        </button>
      )}
    </div>
  );
}
