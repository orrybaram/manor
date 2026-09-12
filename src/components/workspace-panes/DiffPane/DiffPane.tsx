import {
  useEffect,
  useState,
  useMemo,
  useCallback,
  useLayoutEffect,
  useRef,
  useImperativeHandle,
  forwardRef,
} from "react";
import { useMountEffect } from "../../../hooks/useMountEffect";
import * as ContextMenu from "@radix-ui/react-context-menu";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import Clipboard from "lucide-react/dist/esm/icons/clipboard";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import GitCommitVertical from "lucide-react/dist/esm/icons/git-commit-vertical";
import CloudUpload from "lucide-react/dist/esm/icons/cloud-upload";
import { useProjectStore } from "../../../store/project-store";
import {
  useReviewStore,
  NO_DRAFTS,
  type DraftComment,
} from "../../../store/review-store";
import { Stack, Row } from "../../ui/Layout/Layout";
import { parseDiff } from "./parser";
import { countMatches } from "./search-utils";
import { SearchBar } from "./SearchBar/SearchBar";
import { FileHeader } from "./FileHeader/FileHeader";
import { DiffLines } from "./DiffLines/DiffLines";
import { FileList } from "./FileList/FileList";
import { ModeToggle } from "./ModeToggle/ModeToggle";
import { CommitModal } from "./CommitModal/CommitModal";
import { EmptyState } from "./EmptyState/EmptyState";
import type { DiffMode } from "./types";
import styles from "./DiffPane.module.css";
import { Button } from "../../ui/Button/Button";
import { openInEditor } from "../../../lib/editor";
import { categorizePushError, type PushError } from "../../../lib/push-error";
import { useToastStore } from "../../../store/toast-store";
import { onUiRequest } from "../../../utils/ui-request";

export type DiffPaneRef = {
  toggleSearch: () => void;
};

type DiffPaneProps = {
  paneId?: string;
  workspacePath?: string;
};

/** Shared empty set so a workspace with no staged files keeps a stable identity. */
const NO_STAGED_FILES: Set<string> = new Set();

export const DiffPane = forwardRef<DiffPaneRef, DiffPaneProps>(
  function DiffPane(props: DiffPaneProps, ref) {
    const { paneId, workspacePath } = props;
    const [raw, setRaw] = useState<string | null>(null);
    const [diffMode, setDiffMode] = useState<DiffMode>("local");
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const [showBackToTop, setShowBackToTop] = useState(false);
    const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [currentMatch, setCurrentMatch] = useState(0);
    const [commitOpen, setCommitOpen] = useState(false);
    const [pushing, setPushing] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    // Cancel detection: set to true when the user clicks the toast's Cancel
    // action so the `done` handler can distinguish a SIGTERM-induced exit from
    // a real error. Reset at the start of every push.
    const cancelledRef = useRef(false);
    // Holds the elapsed-counter setInterval handle so we can clear it from the
    // `done` handler (and on unmount).
    const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const [headerEl, setHeaderEl] = useState<HTMLDivElement | null>(null);
    const savedSelection = useRef<string>("");
    const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());

    useLayoutEffect(() => {
      const container = containerRef.current;
      if (!headerEl || !container) return;
      const update = () => {
        container.style.setProperty(
          "--diff-header-offset",
          `${headerEl.offsetHeight}px`,
        );
      };
      update();
      const observer = new ResizeObserver(update);
      observer.observe(headerEl);
      return () => observer.disconnect();
    }, [headerEl]);

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

    const openSearch = useCallback(() => {
      setSearchOpen(true);
    }, []);

    // Cmd+F to open search
    useMountEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "f") {
          if (
            !containerRef.current?.contains(document.activeElement) &&
            document.activeElement !== document.body
          )
            return;
          e.preventDefault();
          openSearch();
        }
      };
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    });

    // Edit › Find… (ADR-170) targets whichever pane is focused; open our own
    // search UI when the request names this pane.
    useEffect(() => {
      if (!paneId) return;
      return onUiRequest((request) => {
        if (request.type === "pane-search" && request.paneId === paneId) {
          openSearch();
        }
      });
    }, [paneId, openSearch]);

    const project = useProjectStore((s) =>
      s.projects.find((p) =>
        p.workspaces.some((ws) => ws.path === workspacePath),
      ),
    );
    const defaultBranch = project?.defaultBranch ?? "main";

    // Each fetch is keyed by workspace + mode + branch. `settled` records the
    // outcome of the last completed fetch together with the key it ran for, so
    // `loading` and `error` derive during render instead of being reset by the
    // effect every time the key changes.
    const fetchKey = `${workspacePath ?? ""}\u0000${diffMode}\u0000${defaultBranch}`;
    const [settled, setSettled] = useState<{
      key: string;
      error: string | null;
    } | null>(null);
    const loading = settled?.key !== fetchKey;
    const error = settled?.key === fetchKey ? settled.error : null;

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
              setSettled({ key: fetchKey, error: "No changes found" });
            } else {
              setRaw(result);
              setSettled({ key: fetchKey, error: null });
            }
            requestAnimationFrame(() => {
              if (containerRef.current) {
                containerRef.current.scrollTop = scrollTop;
              }
            });
          })
          .catch((err) => {
            if (cancelled) return;
            setSettled({
              key: fetchKey,
              error:
                err instanceof Error ? err.message : "Failed to load diff",
            });
          });
      };

      fetchDiff();

      const timer = setInterval(fetchDiff, 5000);

      return () => {
        cancelled = true;
        clearInterval(timer);
      };
    }, [workspacePath, defaultBranch, diffMode, fetchKey]);

    const files = useMemo(() => (raw ? parseDiff(raw) : []), [raw]);

    // ── Draft review comments ──

    const drafts = useReviewStore((s) =>
      workspacePath ? (s.drafts[workspacePath] ?? NO_DRAFTS) : NO_DRAFTS,
    );
    const [editingId, setEditingId] = useState<string | null>(null);

    /** Grouped once here so each `DiffLines` is handed only its own file's drafts. */
    const draftsByFile = useMemo(() => {
      const byFile = new Map<string, DraftComment[]>();
      for (const draft of drafts) {
        const existing = byFile.get(draft.filePath);
        if (existing) existing.push(draft);
        else byFile.set(draft.filePath, [draft]);
      }
      return byFile;
    }, [drafts]);

    const handleSaveComment = useCallback(
      (id: string, body: string) => {
        if (!workspacePath) return;
        useReviewStore.getState().updateDraft(workspacePath, id, body);
        setEditingId((current) => (current === id ? null : current));
      },
      [workspacePath],
    );

    /**
     * Cancelling a draft that never got a body is cancelling its *creation* —
     * the chip adds an empty draft up front, so leaving it behind would litter
     * the review with blank comments. An edit to an existing comment just
     * reverts.
     */
    const handleCancelComment = useCallback(
      (id: string) => {
        if (!workspacePath) return;
        const { drafts: all, removeDraft } = useReviewStore.getState();
        const draft = all[workspacePath]?.find((d) => d.id === id);
        if (draft && draft.body.trim() === "") {
          removeDraft(workspacePath, id);
        }
        setEditingId((current) => (current === id ? null : current));
      },
      [workspacePath],
    );

    const handleEditComment = useCallback((id: string) => {
      setEditingId(id);
    }, []);

    const handleDeleteComment = useCallback(
      (id: string) => {
        if (!workspacePath) return;
        useReviewStore.getState().removeDraft(workspacePath, id);
        setEditingId((current) => (current === id ? null : current));
      },
      [workspacePath],
    );

    // Fetch staged file list for local mode. Tagged with the workspace it was
    // fetched for so any other workspace (or full-diff mode) reads as empty
    // without an effect having to clear it.
    const stagedKey =
      workspacePath && diffMode === "local" ? workspacePath : null;
    const [stagedResult, setStagedResult] = useState<{
      key: string;
      files: Set<string>;
    } | null>(null);
    const stagedFiles =
      stagedKey !== null && stagedResult?.key === stagedKey
        ? stagedResult.files
        : NO_STAGED_FILES;

    useEffect(() => {
      if (stagedKey === null) return;
      let cancelled = false;
      const fetchStaged = () => {
        window.electronAPI.diffs.getStagedFiles(stagedKey).then((files) => {
          if (!cancelled) {
            setStagedResult({ key: stagedKey, files: new Set(files) });
          }
        });
      };
      fetchStaged();
      const timer = setInterval(fetchStaged, 5000);
      return () => {
        cancelled = true;
        clearInterval(timer);
      };
    }, [stagedKey]);

    // Optimistic stage/unstage from the file list, applied against the set for
    // the current key so a stale result can never be mutated into place.
    const updateStagedFiles = useCallback(
      (updater: (prev: Set<string>) => Set<string>) => {
        if (stagedKey === null) return;
        setStagedResult((prev) => ({
          key: stagedKey,
          files: updater(prev?.key === stagedKey ? prev.files : NO_STAGED_FILES),
        }));
      },
      [stagedKey],
    );

    // ── Animation tracking ──
    // Compared against the previously rendered file set during render (React's
    // "adjust state when props change") so a file animates in the same commit
    // that reveals it rather than one paint later.
    const [tracked, setTracked] = useState<{
      files: typeof files;
      hashes: Map<string, number>;
    } | null>(null);
    const [animationState, setAnimationState] = useState<
      Map<string, "new" | "updated">
    >(new Map());

    if (tracked?.files !== files) {
      const hashes = new Map<string, number>(
        files.map((f) => [f.path, f.added * 1000 + f.removed + f.lines.length]),
      );
      if (tracked !== null) {
        const newAnimations = new Map<string, "new" | "updated">();
        for (const [path, hash] of hashes) {
          const prevHash = tracked.hashes.get(path);
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
      setTracked({ files, hashes });
    }

    useEffect(() => {
      if (animationState.size === 0) return;
      const timer = setTimeout(() => {
        setAnimationState(new Map());
      }, 500);
      return () => clearTimeout(timer);
    }, [animationState]);

    const handleModeChange = useCallback((mode: DiffMode) => {
      setDiffMode(mode);
      setSelectedFiles(new Set());
    }, []);

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

    const handleSearchChange = useCallback((query: string) => {
      setSearchQuery(query);
      setCurrentMatch(0);
    }, []);

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

    const runPush = useCallback(
      async (opts: { setUpstream?: boolean } = {}) => {
        if (!workspacePath) return;
        const pushId = workspacePath;
        const { addToast, updateToast } = useToastStore.getState();

        // Reset cancel flag for this push attempt.
        cancelledRef.current = false;
        setPushing(true);

        // Show the loading toast immediately — before awaiting `start` — so
        // the user has feedback even on the brief gap before the first
        // progress event arrives.
        const startedAt = Date.now();
        addToast({
          id: pushId,
          status: "loading",
          message: "Pushing… 0s",
          persistent: true,
          action: {
            label: "Cancel",
            onClick: () => {
              cancelledRef.current = true;
              void window.electronAPI.git.push.cancel(pushId);
            },
          },
        });

        // Tick the elapsed counter every 1s. Stored in a ref so the `done`
        // handler (and unmount) can clear it.
        if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = setInterval(() => {
          const elapsed = Math.floor((Date.now() - startedAt) / 1000);
          useToastStore
            .getState()
            .updateToast(pushId, { message: `Pushing… ${elapsed}s` });
        }, 1000);

        try {
          await window.electronAPI.git.push.start({
            wsPath: workspacePath,
            setUpstream: opts.setUpstream,
          });
        } catch (err) {
          // start() rejected (e.g. "already in progress"). Surface as an
          // error toast and clean up the interval — no `done` event will fire.
          if (elapsedTimerRef.current) {
            clearInterval(elapsedTimerRef.current);
            elapsedTimerRef.current = null;
          }
          setPushing(false);
          const message = err instanceof Error ? err.message : String(err);
          updateToast(pushId, {
            status: "error",
            message: message.replace(
              /^Error invoking remote method '[^']+': Error:\s*/i,
              "",
            ),
            persistent: true,
            action: undefined,
            detail: undefined,
          });
        }
      },
      [workspacePath],
    );

    const handlePush = useCallback(() => {
      void runPush();
    }, [runPush]);

    // Subscribe to push progress events for this workspace and drive toast
    // lifecycle from them. The handler filters by pushId === workspacePath so
    // each DiffPane only reacts to its own push.
    useEffect(() => {
      if (!workspacePath) return;
      const unsubscribe = window.electronAPI.git.push.onProgress((evt) => {
        if (evt.pushId !== workspacePath) return;
        const { updateToast } = useToastStore.getState();

        if (evt.type === "line") {
          // Only the latest line is shown in `detail` while loading; the full
          // log is reconstructed in the `done` branch via `stderr`.
          updateToast(evt.pushId, { detail: evt.line });
          return;
        }

        if (evt.type === "done") {
          if (elapsedTimerRef.current) {
            clearInterval(elapsedTimerRef.current);
            elapsedTimerRef.current = null;
          }
          setPushing(false);

          // Success
          if (evt.exitCode === 0) {
            updateToast(evt.pushId, {
              status: "success",
              message: "Pushed",
              persistent: false,
              action: undefined,
              detail: undefined,
              duration: 3000,
            });
            return;
          }

          // Cancelled — detected via the ref-tracked Cancel callback rather
          // than parsing exit codes (SIGTERM exit varies by platform).
          if (cancelledRef.current) {
            updateToast(evt.pushId, {
              status: "error",
              message: "Push cancelled",
              persistent: false,
              action: undefined,
              detail: undefined,
              duration: 3000,
            });
            return;
          }

          // Categorized failure
          const pushError: PushError = categorizePushError(evt.stderr);
          const stderrTrimmed = evt.stderr.trim();
          updateToast(evt.pushId, {
            status: "error",
            message: pushError.message,
            detail: stderrTrimmed.length > 0 ? stderrTrimmed : undefined,
            persistent: true,
            autoExpand: true,
            action:
              pushError.action?.kind === "set-upstream"
                ? {
                    label: pushError.action.label,
                    onClick: () => {
                      void runPush({ setUpstream: true });
                    },
                  }
                : undefined,
            // NOTE: pull-and-retry has no IPC `pull` method available yet, so
            // we omit the action button. Tracked as ADR-140 follow-up.
          });
        }
      });
      return () => {
        unsubscribe();
      };
    }, [workspacePath, runPush]);

    // Clear any pending elapsed-counter interval on unmount so we don't leak.
    useEffect(() => {
      return () => {
        if (elapsedTimerRef.current) {
          clearInterval(elapsedTimerRef.current);
          elapsedTimerRef.current = null;
        }
      };
    }, []);

    const topBar = (
      <div className={styles.topBar}>
        <ModeToggle diffMode={diffMode} onModeChange={handleModeChange} />
        <Row gap="xs" align="center" className={styles.actionGroup}>
          <Button
            variant="secondary"
            onClick={handlePush}
            disabled={pushing}
          >
            {pushing ? (
              <span className={styles.pushSpinner} />
            ) : (
              <CloudUpload size={13} />
            )}
            {pushing ? "Pushing…" : "Push"}
          </Button>
          <Button
            onClick={() => setCommitOpen(true)}
            disabled={stagedFiles.size === 0}
            variant="primary"
          >
            <GitCommitVertical size={13} />
            Commit
          </Button>
        </Row>
      </div>
    );

    if (loading) {
      return (
        <div className={styles.container} ref={containerRef}>
          <div className={styles.header} ref={setHeaderEl}>{topBar}</div>
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
        <div className={styles.container} ref={containerRef}>
          <div className={styles.header} ref={setHeaderEl}>{topBar}</div>
          <EmptyState message={error} />
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
        <div className={styles.header} ref={setHeaderEl}>
          {searchOpen && (
            <SearchBar
              query={searchQuery}
              onChange={handleSearchChange}
              totalMatches={totalMatches}
              currentMatch={currentMatch}
              onNext={handleSearchNext}
              onPrev={handleSearchPrev}
              onClose={handleSearchClose}
            />
          )}
          {topBar}
        </div>
        <div className={styles.body}>
          <div className={styles.fileListWrapper}>
            <FileList
              files={files}
              onSelectFile={scrollToFile}
              animationState={animationState}
              diffMode={diffMode}
              workspacePath={workspacePath}
              selectedFiles={selectedFiles}
              onSelectionChange={setSelectedFiles}
              stagedFiles={stagedFiles}
              onStagedFilesChange={updateStagedFiles}
            />
          </div>
          <Stack gap="lg" className={styles.fileStack}>
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
                    const container =
                      ancestor?.closest("[data-diff-lines]") ??
                      ancestor?.querySelector("[data-diff-lines]");
                    const rows = container?.querySelectorAll("[data-index]");

                    const lines: string[] = [];
                    if (rows) {
                      for (const row of rows) {
                        if (!sel.containsNode(row, true)) continue;
                        const children = row.children;
                        const numCell = children[0];
                        const contentCell = children[1];
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
                      comments={draftsByFile.get(file.path)}
                      editingId={editingId}
                      onSaveComment={handleSaveComment}
                      onCancelComment={handleCancelComment}
                      onEditComment={handleEditComment}
                      onDeleteComment={handleDeleteComment}
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
                          openInEditor(
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
        </div>
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
