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
import FileCode from "lucide-react/dist/esm/icons/file-code";
import GitCommitVertical from "lucide-react/dist/esm/icons/git-commit-vertical";
import CloudUpload from "lucide-react/dist/esm/icons/cloud-upload";
import MessageSquarePlus from "lucide-react/dist/esm/icons/message-square-plus";
import { useProjectStore } from "../../../store/project-store";
import { ownerOf } from "../../../lib/workspace-directory";
import { workspaceKey } from "../../../lib/workspace-key";

import { Stack, Row } from "../../ui/Layout/Layout";
import { parseDiff } from "./parser";
import { countMatches } from "./search-utils";
import { SearchBar } from "./SearchBar/SearchBar";
import { FileHeader } from "./FileHeader/FileHeader";
import { DiffLines } from "./DiffLines/DiffLines";
import { CollapsedPreview } from "./CollapsedPreview/CollapsedPreview";
import { autoCollapseReason, collapsedFiles } from "./auto-collapse";
import {
  DiffScrollContext,
  type DiffLinesHandle,
  type DiffScroll,
} from "./DiffLines/diff-scroll";
import { FileList } from "./FileList/FileList";
import { ModeToggle } from "./ModeToggle/ModeToggle";
import { CommitModal } from "./CommitModal/CommitModal";
import { EmptyState } from "./EmptyState/EmptyState";
import { SelectionCommentChip } from "./SelectionCommentChip/SelectionCommentChip";
import { useDraftReview } from "./use-draft-review";
import { fetchDiffSingleFlight, fetchStagedSingleFlight, localDiffKey } from "./diff-fetch";
import { FingerprintedFetch } from "./FingerprintedFetch";
import { ReviewBar } from "../../review/ReviewSend/ReviewSend";
import { selectionSnippet, selectionToAnchor } from "./review-anchor";
import type { SelectionAnchor } from "./review-anchor";
import type { DiffMode } from "./types";
import styles from "./DiffPane.module.css";
import { Button } from "../../ui/Button/Button";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import { openInEditor } from "../../../lib/editor";
import { openFileBeside } from "../../../lib/open-in-file-pane";
import { startPush, usePushing } from "../FilePane/SourceControl/push";
import { onUiRequest } from "../../../utils/ui-request";
import { Collapse } from "../../ui/Collapse/Collapse";
import { isWebApp } from "../../../lib/platform";

export type DiffPaneRef = {
  toggleSearch: () => void;
};

type DiffPaneProps = {
  paneId?: string;
  workspacePath?: string;
  /** The workspace's host. */
  hostId?: string;
};

/** Frames to wait for a search match's row to be built before giving up. */
const MATCH_REVEAL_FRAMES = 30;

/** Frames a file-list jump keeps re-aiming while the rows around it settle. */
const FILE_JUMP_FRAMES = 60;

/** Shared empty set so a workspace with no staged files keeps a stable identity. */
const NO_STAGED_FILES: Set<string> = new Set();

export const DiffPane = forwardRef<DiffPaneRef, DiffPaneProps>(
  function DiffPane(props: DiffPaneProps, ref) {
    const { paneId, workspacePath, hostId } = props;
    const [raw, setRaw] = useState<string | null>(null);
    const [diffMode, setDiffMode] = useState<DiffMode>("local");
    // Files the user expanded or collapsed themselves; every other file
    // follows the default for its size and kind (`collapsedFiles`).
    const [collapseChoices, setCollapseChoices] = useState<
      ReadonlyMap<string, boolean>
    >(new Map());
    const collapseDefaults = useRef(new Map<string, boolean>());
    const [showBackToTop, setShowBackToTop] = useState(false);
    const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [currentMatch, setCurrentMatch] = useState(0);
    const [commitOpen, setCommitOpen] = useState(false);
    const pushing = usePushing(workspacePath);
    const containerRef = useRef<HTMLDivElement | null>(null);
    // The same element as `containerRef`, as state: the files' rows
    // virtualize against it, so they re-render once it exists.
    const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
    const setContainer = useCallback((el: HTMLDivElement | null) => {
      containerRef.current = el;
      setScroller(el);
    }, []);
    const [fileStackEl, setFileStackEl] = useState<HTMLDivElement | null>(null);
    // Watched too: in a narrow pane the file list sits above the files, so
    // opening it moves every file without resizing the stack.
    const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);
    const lineHandles = useRef(new Map<string, DiffLinesHandle>());
    const [headerEl, setHeaderEl] = useState<HTMLDivElement | null>(null);
    /**
     * Snapshotted when the context menu opens, because by the time an item is
     * chosen the menu has taken focus and the selection may be gone. The
     * anchor has to be resolved up front for the same reason.
     *
     * State, not a ref: the "Comment on selection" item's `disabled` is
     * derived from it during render, and a ref mutation schedules no render
     * to derive it in.
     */
    const [savedSelection, setSavedSelection] = useState<{
      text: string;
      anchor: SelectionAnchor | null;
    }>({ text: "", anchor: null });
    const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());
    const fileJump = useRef<number | null>(null);

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

    const diffScroll = useMemo<DiffScroll>(
      () => ({
        scroller,
        watch: [headerEl, bodyEl, fileStackEl].filter(
          (el): el is HTMLDivElement => el !== null,
        ),
        handles: lineHandles.current,
      }),
      [scroller, headerEl, bodyEl, fileStackEl],
    );

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
      setCollapseChoices((prev) => {
        const closed =
          prev.get(path) ?? collapseDefaults.current.get(path) ?? false;
        return new Map(prev).set(path, !closed);
      });
    }, []);

    /** Un-collapse a file, so anything anchored inside it has somewhere to go. */
    const revealFile = useCallback((path: string) => {
      setCollapseChoices((prev) => {
        const closed =
          prev.get(path) ?? collapseDefaults.current.get(path) ?? false;
        return closed ? new Map(prev).set(path, false) : prev;
      });
    }, []);

    /**
     * Bring a file's top up to just under the pane's header.
     *
     * Not a smooth `scrollIntoView`: rows build and measure as the pane
     * passes them, every file above the target changes height mid-flight,
     * and the virtualizer's own scroll corrections cancel the animation — on
     * a large diff it stopped a screen or so from where it set out. So the
     * pane jumps, then re-aims each frame while the rows near the file
     * settle, until the file holds still under the header.
     */
    const scrollToFile = useCallback(
      (path: string) => {
        revealFile(path);
        if (fileJump.current !== null) cancelAnimationFrame(fileJump.current);
        let frames = 0;
        let still = 0;
        const aim = () => {
          fileJump.current = null;
          const container = containerRef.current;
          const file = fileRefs.current.get(path);
          if (!container || !file) return;
          const headerBottom =
            container.getBoundingClientRect().top +
            (headerEl?.offsetHeight ?? 0);
          const drift = file.getBoundingClientRect().top - headerBottom;
          const before = container.scrollTop;
          if (Math.abs(drift) >= 1) container.scrollTop = before + drift;
          // At rest once a frame neither needs nor can make a correction (a
          // file near the end of the diff can never reach the top).
          still = container.scrollTop === before ? still + 1 : 0;
          if (still < 2 && frames++ < FILE_JUMP_FRAMES)
            fileJump.current = requestAnimationFrame(aim);
        };
        fileJump.current = requestAnimationFrame(aim);
      },
      [revealFile, headerEl],
    );
    useEffect(
      () => () => {
        if (fileJump.current !== null) cancelAnimationFrame(fileJump.current);
      },
      [],
    );

    // A changed file, in a file pane beside this one: the one already in
    // this tab, or a new split to the right. Needs the pane and its workspace.
    const openFile = useMemo(
      () =>
        paneId && workspacePath
          ? (path: string) => openFileBeside(paneId, path, "horizontal")
          : undefined,
      [paneId, workspacePath],
    );

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

    // Edit › Find… targets whichever pane is focused; open our own
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
      workspacePath
        ? ownerOf(s.projects, workspaceKey(hostId, workspacePath))
        : undefined,
    );
    const defaultBranch = project?.defaultBranch ?? "main";

    // The workspace's identity across hosts. Its diff fingerprint changes
    // whenever its diff or staged files may have; the `FingerprintedFetch`es
    // below re-fetch only then.
    const wsKey = workspacePath ? workspaceKey(hostId, workspacePath) : null;

    // Each fetch is keyed by workspace + mode (+ branch, which only the
    // branch diff reads). `settled` records the outcome of the last completed
    // fetch together with the key it ran for, so `loading` and `error` derive
    // during render instead of being reset every time the key changes.
    const fetchKey =
      diffMode === "local"
        ? localDiffKey(wsKey ?? "")
        : `${wsKey ?? ""}\u0000branch\u0000${defaultBranch}`;
    const [settled, setSettled] = useState<{
      key: string;
      error: string | null;
    } | null>(null);
    const loading = settled?.key !== fetchKey;
    const error = settled?.key === fetchKey ? settled.error : null;

    /**
     * Record a fetch's outcome, but only when it is actually a different
     * outcome.
     *
     * The diff is re-fetched whenever the workspace's fingerprint moves, and
     * can come back byte-identical, so `setRaw` bails on its own. A fresh
     * `{ key, error }` object does not: it is a new identity every fetch, and
     * it re-rendered the whole pane —
     * every file, every row — for a result that had not changed. That work
     * lands on the same main thread as whatever the user is doing, and a drag
     * in flight when it fires simply stops until it finishes.
     */
    const settleOnce = useCallback(
      (key: string, nextError: string | null) =>
        setSettled((prev) =>
          prev && prev.key === key && prev.error === nextError
            ? prev
            : { key, error: nextError },
        ),
      [],
    );

    const applyDiff = useCallback(
      (key: string, result: string | null) => {
        const scrollTop = containerRef.current?.scrollTop ?? 0;
        if (!result || result.trim() === "") {
          setRaw(null);
          settleOnce(key, "No changes found");
        } else {
          setRaw(result);
          settleOnce(key, null);
        }
        requestAnimationFrame(() => {
          if (containerRef.current) {
            containerRef.current.scrollTop = scrollTop;
          }
        });
      },
      [settleOnce],
    );

    const files = useMemo(() => (raw ? parseDiff(raw) : []), [raw]);
    const collapsed = useMemo(
      () => collapsedFiles(files, collapseChoices, collapseDefaults.current),
      [files, collapseChoices],
    );
    const collapsedRef = useRef(collapsed);
    collapsedRef.current = collapsed;

    const review = useDraftReview({
      workspacePath,
      files,
      containerRef,
      fileRefs,
      lineHandles,
      revealFile,
    });

    // ⌘↩ / Ctrl+↩ with a live selection inside the pane starts a comment on
    // it — the same path as clicking the floating chip.
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (!(e.metaKey || e.ctrlKey) || e.key !== "Enter") return;
        // The composer's own ⌘↩ already stops propagation before this
        // window-level listener would see the event, so this only fires for
        // a selection out in the diff, not while typing a comment.
        if (
          !containerRef.current?.contains(document.activeElement) &&
          document.activeElement !== document.body
        )
          return;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.anchorNode) return;
        if (!containerRef.current?.contains(sel.anchorNode)) return;
        const anchor = selectionToAnchor(sel);
        if (!anchor) return;
        e.preventDefault();
        review.startComment(anchor);
      };
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }, [review]);

    // Staged file list for local mode, fetched by a `FingerprintedFetch`
    // below. Tagged with the workspace it was fetched for so any other
    // workspace (or full-diff mode) reads as empty without having to clear it.
    const stagedKey = diffMode === "local" ? wsKey : null;
    const [stagedResult, setStagedResult] = useState<{
      key: string;
      files: Set<string>;
    } | null>(null);
    const stagedFiles =
      stagedKey !== null && stagedResult?.key === stagedKey
        ? stagedResult.files
        : NO_STAGED_FILES;

    // Optimistic stage/unstage from the file list, applied against the set for
    // the current key so a stale result can never be mutated into place.
    const updateStagedFiles = useCallback(
      (updater: (prev: Set<string>) => Set<string>) => {
        if (stagedKey === null) return;
        setStagedResult((prev) => ({
          key: stagedKey,
          files: updater(
            prev?.key === stagedKey ? prev.files : NO_STAGED_FILES,
          ),
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

    // The match's row may not be built: its file scrolls there by index
    // first, and the highlighted match is centred once it exists. Not re-run
    // when the diff refreshes: that would pull the pane back to the match
    // every time an agent saves a file.
    const filesRef = useRef(files);
    filesRef.current = files;
    useEffect(() => {
      if (!searchQuery || totalMatches === 0) return;
      for (const file of filesRef.current) {
        // A file closing still has its rows mounted, but its matches are no
        // longer counted (`fileOffsets`).
        if (collapsedRef.current.has(file.path)) continue;
        if (lineHandles.current.get(file.path)?.scrollToMatch(currentMatch))
          break;
      }
      let frames = 0;
      let frame = requestAnimationFrame(function reveal() {
        const el = containerRef.current?.querySelector(
          `[data-match-index="${currentMatch}"]`,
        );
        if (el) el.scrollIntoView({ block: "center" });
        else if (frames++ < MATCH_REVEAL_FRAMES)
          frame = requestAnimationFrame(reveal);
      });
      return () => cancelAnimationFrame(frame);
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

    const handlePush = useCallback(() => {
      if (workspacePath) void startPush(workspacePath);
    }, [workspacePath]);

    // `git.*` is not on the slice-1 bridge table, so Push and Commit
    // would only ever round-trip to a `BridgeUnavailableError` (`startPush`
    // still catches that as a fallback). Disabling with a reason said up
    // front beats the same refusal arriving as a toast after every click.
    const webApp = isWebApp();
    const pushButton = (
      <Button
        variant="secondary"
        onClick={handlePush}
        disabled={pushing || webApp}
      >
        {pushing ? (
          <span className={styles.pushSpinner} />
        ) : (
          <CloudUpload size={13} />
        )}
        {pushing ? "Pushing…" : "Push"}
      </Button>
    );
    const commitButton = (
      <Button
        onClick={() => setCommitOpen(true)}
        disabled={stagedFiles.size === 0 || webApp}
        variant="primary"
      >
        <GitCommitVertical size={13} />
        Commit
      </Button>
    );
    const topBar = (
      <div className={styles.topBar}>
        <ModeToggle diffMode={diffMode} onModeChange={handleModeChange} />
        <Row gap="xs" align="center" className={styles.actionGroup}>
          {webApp ? (
            <Tooltip label="Git isn't available from the browser yet">
              {pushButton}
            </Tooltip>
          ) : (
            pushButton
          )}
          {webApp ? (
            <Tooltip label="Git isn't available from the browser yet">
              {commitButton}
            </Tooltip>
          ) : (
            commitButton
          )}
        </Row>
      </div>
    );

    // First child of every branch's container below, so switching between
    // loading, error and the diff never remounts (and re-fetches) them.
    const fetchers = (
      <>
        {workspacePath && wsKey && (
          <FingerprintedFetch
            key={fetchKey}
            wsKey={wsKey}
            // One fetch per workspace and mode at a time, across panes.
            fetch={() =>
              fetchDiffSingleFlight(fetchKey, () =>
                diffMode === "local"
                  ? window.electronAPI.diffs.getLocalDiff(workspacePath)
                  : window.electronAPI.diffs.getFullDiff(
                      workspacePath,
                      defaultBranch,
                    ),
              )
            }
            onResult={(result) => applyDiff(fetchKey, result)}
            onError={(err) =>
              settleOnce(
                fetchKey,
                err instanceof Error ? err.message : "Failed to load diff",
              )
            }
          />
        )}
        {workspacePath && stagedKey !== null && (
          <FingerprintedFetch
            key={`staged\u0000${stagedKey}`}
            wsKey={stagedKey}
            fetch={() =>
              fetchStagedSingleFlight(stagedKey, () =>
                window.electronAPI.diffs.getStagedFiles(workspacePath),
              )
            }
            onResult={(files) =>
              setStagedResult({ key: stagedKey, files: new Set(files) })
            }
          />
        )}
      </>
    );

    if (loading) {
      return (
        <div className={styles.container} ref={containerRef}>
          {fetchers}
          <div className={styles.header} ref={setHeaderEl}>
            {topBar}
          </div>
          <div className={styles.status}>Loading diff...</div>
          {workspacePath && (
            <div className={styles.bottomDock}>
              <ReviewBar
                workspacePath={workspacePath}
                hostId={hostId}
                onJumpToComment={review.jumpToComment}
                discard
              />
            </div>
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
    }

    if (error) {
      return (
        <div className={styles.container} ref={containerRef}>
          {fetchers}
          <div className={styles.header} ref={setHeaderEl}>
            {topBar}
          </div>
          <EmptyState message={error} />
          {workspacePath && (
            <div className={styles.bottomDock}>
              <ReviewBar
                workspacePath={workspacePath}
                hostId={hostId}
                onJumpToComment={review.jumpToComment}
                discard
              />
            </div>
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
    }

    return (
      <div
        className={styles.container}
        ref={setContainer}
        onScroll={handleScroll}
      >
        {fetchers}
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
        <div className={styles.body} ref={setBodyEl}>
          <div className={styles.fileListWrapper}>
            <FileList
              files={files}
              onSelectFile={scrollToFile}
              onOpenFile={openFile}
              animationState={animationState}
              diffMode={diffMode}
              workspacePath={workspacePath}
              selectedFiles={selectedFiles}
              onSelectionChange={setSelectedFiles}
              stagedFiles={stagedFiles}
              onStagedFilesChange={updateStagedFiles}
            />
          </div>
          <DiffScrollContext.Provider value={diffScroll}>
            <Stack gap="lg" className={styles.fileStack} ref={setFileStackEl}>
              {files.map((file) => {
                const annotations = review.annotationsFor(file.path);
                return (
                  <ContextMenu.Root
                    key={file.path}
                    onOpenChange={(open) => {
                      if (!open) return;
                      const sel = window.getSelection();
                      setSavedSelection({
                        text: sel?.toString() ?? "",
                        anchor: sel ? selectionToAnchor(sel) : null,
                      });
                    }}
                  >
                    <ContextMenu.Trigger asChild>
                      <div
                        data-file-path={file.path}
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

                          const body = selectionSnippet(sel) ?? sel.toString();
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
                          onOpenFile={
                            openFile && !file.deleted
                              ? () => openFile(file.path)
                              : undefined
                          }
                        />
                        {collapsed.has(file.path) &&
                          autoCollapseReason(file) && (
                            <CollapsedPreview
                              file={file}
                              onExpand={() => toggleFile(file.path)}
                            />
                          )}
                        <Collapse open={!collapsed.has(file.path)}>
                          <DiffLines
                            lines={file.lines}
                            filePath={file.path}
                            // A file closing keeps its rows for the animation,
                            // but its matches no longer count.
                            searchQuery={
                              collapsed.has(file.path) ? "" : searchQuery
                            }
                            matchOffset={fileOffsets.get(file.path) ?? 0}
                            currentMatch={currentMatch}
                            renderRowExtra={annotations?.renderRowExtra}
                            markedRows={annotations?.markedRows}
                          />
                        </Collapse>
                      </div>
                    </ContextMenu.Trigger>
                    <ContextMenu.Portal>
                      <ContextMenu.Content className={styles.contextMenu}>
                        {workspacePath && (
                          <>
                            <ContextMenu.Item
                              className={styles.contextMenuItem}
                              disabled={!savedSelection.anchor}
                              onSelect={() => {
                                const { anchor } = savedSelection;
                                if (anchor)
                                  review.startComment(anchor, file.path);
                              }}
                            >
                              <MessageSquarePlus size={14} />
                              Comment on selection
                            </ContextMenu.Item>
                            <ContextMenu.Separator
                              className={styles.contextMenuSeparator}
                            />
                          </>
                        )}
                        <ContextMenu.Item
                          className={styles.contextMenuItem}
                          onSelect={() => {
                            if (savedSelection.text)
                              navigator.clipboard.writeText(
                                savedSelection.text,
                              );
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
                            {openFile && !file.deleted && (
                              <ContextMenu.Item
                                className={styles.contextMenuItem}
                                data-testid="diff-file-menu-open"
                                onSelect={() => openFile(file.path)}
                              >
                                <FileCode size={14} />
                                Open File
                              </ContextMenu.Item>
                            )}
                            <ContextMenu.Item
                              className={styles.contextMenuItem}
                              onSelect={() => {
                                openInEditor(`${workspacePath}/${file.path}`);
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
                );
              })}
            </Stack>
          </DiffScrollContext.Provider>
        </div>
        {workspacePath && (
          <SelectionCommentChip
            containerRef={containerRef}
            onComment={review.startComment}
          />
        )}
        <div className={styles.bottomDock}>
          {workspacePath && (
            <ReviewBar
              workspacePath={workspacePath}
              hostId={hostId}
              onJumpToComment={review.jumpToComment}
              discard
            />
          )}
          {/* Always in the dock, only shown past the fold: inserting it
              resizes the dock, which sits in the scroller's flow, and on a
              large diff that restyles and relays out every row — seconds. */}
          <button
            className={styles.backToTop}
            onClick={scrollToTop}
            aria-label="Back to top"
            data-hidden={showBackToTop ? undefined : ""}
            tabIndex={showBackToTop ? undefined : -1}
          >
            <ArrowUp size={14} />
          </button>
        </div>
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
