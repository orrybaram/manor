import {
  useEffect,
  useState,
  useMemo,
  useCallback,
  useRef,
  useImperativeHandle,
  forwardRef,
} from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import Clipboard from "lucide-react/dist/esm/icons/clipboard";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import GitCommitVertical from "lucide-react/dist/esm/icons/git-commit-vertical";
import { useProjectStore } from "../../../store/project-store";
import { Stack } from "../../ui/Layout/Layout";
import { parseDiff } from "./parser";
import { countMatches } from "./search-utils";
import { SearchBar } from "./SearchBar/SearchBar";
import { FileHeader } from "./FileHeader/FileHeader";
import { DiffLines } from "./DiffLines/DiffLines";
import { FileList } from "./FileList/FileList";
import { ModeToggle } from "./ModeToggle/ModeToggle";
import { CommitModal } from "./CommitModal/CommitModal";
import type { DiffMode } from "./types";
import styles from "./DiffPane.module.css";
import { Button } from "../../ui/Button/Button";

export type DiffPaneRef = {
  toggleSearch: () => void;
};

type DiffPaneProps = {
  workspacePath?: string;
};

export const DiffPane = forwardRef<DiffPaneRef, DiffPaneProps>(
  function DiffPane({ workspacePath }, ref) {
    const [raw, setRaw] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [diffMode, setDiffMode] = useState<DiffMode>("local");
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const [showBackToTop, setShowBackToTop] = useState(false);
    const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [currentMatch, setCurrentMatch] = useState(0);
    const [commitOpen, setCommitOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const savedSelection = useRef<string>("");
    const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());

    useImperativeHandle(ref, () => ({
      toggleSearch: () => setSearchOpen((v) => !v),
    }));

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
      setCollapsed((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      requestAnimationFrame(() => {
        fileRefs.current
          .get(path)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }, []);

    // Cmd+F to open search
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "f") {
          if (
            !containerRef.current?.contains(document.activeElement) &&
            document.activeElement !== document.body
          )
            return;
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
        const promise =
          diffMode === "local"
            ? window.electronAPI.diffs.getLocalDiff(workspacePath)
            : window.electronAPI.diffs.getFullDiff(
                workspacePath,
                defaultBranch,
              );

        promise
          .then((result) => {
            if (cancelled) return;
            const scrollTop = containerRef.current?.scrollTop ?? 0;
            if (!result || result.trim() === "") {
              setRaw(null);
              setError("No changes found");
            } else {
              setRaw(result);
              setError(null);
            }
            requestAnimationFrame(() => {
              if (containerRef.current) {
                containerRef.current.scrollTop = scrollTop;
              }
            });
          })
          .catch((err) => {
            if (cancelled) return;
            setError(
              err instanceof Error ? err.message : "Failed to load diff",
            );
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
    }, [workspacePath, defaultBranch, diffMode]);

    const files = useMemo(() => (raw ? parseDiff(raw) : []), [raw]);

    // Fetch staged file list for local mode
    const [stagedFiles, setStagedFiles] = useState<Set<string>>(new Set());
    useEffect(() => {
      if (!workspacePath || diffMode !== "local") {
        setStagedFiles(new Set());
        return;
      }
      let cancelled = false;
      const fetchStaged = () => {
        window.electronAPI.diffs.getStagedFiles(workspacePath).then((files) => {
          if (!cancelled) setStagedFiles(new Set(files));
        });
      };
      fetchStaged();
      const timer = setInterval(fetchStaged, 5000);
      return () => {
        cancelled = true;
        clearInterval(timer);
      };
    }, [workspacePath, diffMode]);

    // ── Animation tracking ──
    const previousFiles = useRef<Map<string, number> | null>(null);
    const [animationState, setAnimationState] = useState<
      Map<string, "new" | "updated">
    >(new Map());

    useEffect(() => {
      const currentHash = new Map<string, number>(
        files.map((f) => [f.path, f.added * 1000 + f.removed + f.lines.length]),
      );

      if (previousFiles.current !== null) {
        const newAnimations = new Map<string, "new" | "updated">();
        for (const [path, hash] of currentHash) {
          const prevHash = previousFiles.current.get(path);
          if (prevHash === undefined) {
            newAnimations.set(path, "new");
          } else if (prevHash !== hash) {
            newAnimations.set(path, "updated");
          }
        }
        if (newAnimations.size > 0) {
          setAnimationState(newAnimations);
        }
      }

      previousFiles.current = currentHash;
    }, [files]);

    useEffect(() => {
      if (animationState.size === 0) return;
      const timer = setTimeout(() => {
        setAnimationState(new Map());
      }, 500);
      return () => clearTimeout(timer);
    }, [animationState]);

    // Clear selection when diff mode changes
    useEffect(() => {
      setSelectedFiles(new Set());
    }, [diffMode]);

    // Compute per-file match offsets and total
    const { fileOffsets, totalMatches } = useMemo(() => {
      if (!searchQuery)
        return { fileOffsets: new Map<string, number>(), totalMatches: 0 };
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

    useEffect(() => {
      setCurrentMatch(0);
    }, [searchQuery, totalMatches]);

    useEffect(() => {
      if (!searchQuery || totalMatches === 0) return;
      requestAnimationFrame(() => {
        const el = containerRef.current?.querySelector(
          `[data-match-index="${currentMatch}"]`,
        );
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
          <div className={styles.topBar}>
            <ModeToggle diffMode={diffMode} onModeChange={setDiffMode} />
            <Button
              onClick={() => setCommitOpen(true)}
              disabled={stagedFiles.size === 0}
              variant="primary"
            >
              <GitCommitVertical size={13} />
              Commit
            </Button>
          </div>
          <div className={styles.status}>Loading diff...</div>
          {workspacePath && (
            <CommitModal
              open={commitOpen}
              onOpenChange={setCommitOpen}
              workspacePath={workspacePath}
              stagedCount={stagedFiles.size}
            />
          )}
        </div>
      );
    }

    if (error) {
      return (
        <div className={styles.container}>
          <div className={styles.topBar}>
            <ModeToggle diffMode={diffMode} onModeChange={setDiffMode} />
            <Button
              onClick={() => setCommitOpen(true)}
              disabled={stagedFiles.size === 0}
              variant="primary"
            >
              <GitCommitVertical size={13} />
              Commit
            </Button>
          </div>
          <div className={styles.status}>{error}</div>
          {workspacePath && (
            <CommitModal
              open={commitOpen}
              onOpenChange={setCommitOpen}
              workspacePath={workspacePath}
              stagedCount={stagedFiles.size}
            />
          )}
        </div>
      );
    }

    return (
      <div
        className={styles.container}
        ref={containerRef}
        onScroll={handleScroll}
      >
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
        <div className={styles.topBar}>
          <ModeToggle diffMode={diffMode} onModeChange={setDiffMode} />
          <Button
            onClick={() => setCommitOpen(true)}
            disabled={stagedFiles.size === 0}
            variant="primary"
          >
            <GitCommitVertical size={13} />
            Commit
          </Button>
        </div>
        <Stack gap="lg" className={styles.fileStack}>
          <FileList
            files={files}
            onSelectFile={scrollToFile}
            animationState={animationState}
            diffMode={diffMode}
            workspacePath={workspacePath}
            selectedFiles={selectedFiles}
            onSelectionChange={setSelectedFiles}
            stagedFiles={stagedFiles}
            onStagedFilesChange={(updater) => setStagedFiles(updater)}
          />
          {files.map((file) => (
            <ContextMenu.Root
              key={file.path}
              onOpenChange={(open) => {
                if (open)
                  savedSelection.current =
                    window.getSelection()?.toString() ?? "";
              }}
            >
              <ContextMenu.Trigger asChild>
                <div
                  className={[
                    styles.file,
                    animationState.get(file.path) === "new"
                      ? styles.fileNew
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  ref={(el) => {
                    if (el) fileRefs.current.set(file.path, el);
                    else fileRefs.current.delete(file.path);
                  }}
                  onCopy={(e) => {
                    const sel = window.getSelection();
                    if (!sel || sel.isCollapsed) return;

                    e.preventDefault();

                    const range = sel.getRangeAt(0);
                    const ancestor =
                      range.commonAncestorContainer instanceof HTMLElement
                        ? range.commonAncestorContainer
                        : range.commonAncestorContainer.parentElement;
                    const table =
                      ancestor?.closest("table") ??
                      ancestor?.querySelector("table");
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

                    const body =
                      lines.length > 0 ? lines.join("\n") : sel.toString();
                    e.clipboardData.setData(
                      "text/plain",
                      `${file.path}\n${body}`,
                    );
                  }}
                >
                  <FileHeader
                    file={file}
                    collapsed={collapsed.has(file.path)}
                    animated={animationState.get(file.path) === "updated"}
                    onToggle={() => toggleFile(file.path)}
                  />
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
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content className={styles.contextMenu}>
                  <ContextMenu.Item
                    className={styles.contextMenuItem}
                    onSelect={() => {
                      if (savedSelection.current)
                        navigator.clipboard.writeText(savedSelection.current);
                    }}
                  >
                    <Clipboard size={14} />
                    Copy
                  </ContextMenu.Item>
                  {workspacePath && (
                    <>
                      <ContextMenu.Separator
                        className={styles.contextMenuSeparator}
                      />
                      <ContextMenu.Item
                        className={styles.contextMenuItem}
                        onSelect={() => {
                          window.electronAPI.shell.openInEditor(
                            `${workspacePath}/${file.path}`,
                          );
                        }}
                      >
                        <ExternalLink size={14} />
                        Open in Editor
                      </ContextMenu.Item>
                    </>
                  )}
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          ))}
        </Stack>
        {showBackToTop && (
          <button
            className={styles.backToTop}
            onClick={scrollToTop}
            aria-label="Back to top"
          >
            <ArrowUp size={14} />
          </button>
        )}
        {workspacePath && (
          <CommitModal
            open={commitOpen}
            onOpenChange={setCommitOpen}
            workspacePath={workspacePath}
            stagedCount={stagedFiles.size}
          />
        )}
      </div>
    );
  },
);
