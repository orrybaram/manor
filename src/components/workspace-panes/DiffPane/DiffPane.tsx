import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import { useProjectStore } from "../../../store/project-store";
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

function DiffLines({ lines }: { lines: DiffLine[] }) {
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
          return (
            <tr key={i} className={rowClass}>
              <td className={numClass}>{num}</td>
              <td className={styles.lineContent}>
                <span className={styles.prefix}>{prefix}</span>
                {line.content}
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
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());

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

  const project = useProjectStore((s) =>
    s.projects.find((p) =>
      p.workspaces.some((ws) => ws.path === workspacePath),
    ),
  );
  const defaultBranch = project?.defaultBranch ?? "main";

  useEffect(() => {
    if (!workspacePath) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    window.electronAPI.diffs
      .getFullDiff(workspacePath, defaultBranch)
      .then((result) => {
        if (cancelled) return;
        if (!result || result.trim() === "") {
          setError("No changes found");
        } else {
          setRaw(result);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load diff");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [workspacePath, defaultBranch]);

  const files = useMemo(() => (raw ? parseDiff(raw) : []), [raw]);

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
    <div className={styles.container}>
      <FileList files={files} onSelectFile={scrollToFile} />
      {files.map((file) => (
        <div key={file.path} className={styles.file} ref={(el) => { if (el) fileRefs.current.set(file.path, el); else fileRefs.current.delete(file.path); }}>
          <FileHeader file={file} collapsed={collapsed.has(file.path)} onToggle={() => toggleFile(file.path)} />
          {!collapsed.has(file.path) && <DiffLines lines={file.lines} />}
        </div>
      ))}
    </div>
  );
}
