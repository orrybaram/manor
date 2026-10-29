import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef, memo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as ContextMenu from "@radix-ui/react-context-menu";
import X from "lucide-react/dist/esm/icons/x";
import Search from "lucide-react/dist/esm/icons/search";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import HardDrive from "lucide-react/dist/esm/icons/hard-drive";
import type { AgentInfo } from "../../../electron.d";
import { useAgentStore } from "../../../store/agent-store";
import { useRestoreFocus } from "../../../hooks/useRestoreFocus";
import { AgentDot } from "../../ui/AgentDot/AgentDot";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import { useAgentDisplay, useCleanPaneTitles } from "../../../hooks/useAgentDisplay";
import { useOpenPaneIds } from "../../../hooks/useOpenPaneIds";
import { projectColorStyle } from "../../../hooks/useProjectHeaderRow";
import { useProjectStore } from "../../../store/project-store";
import { useAgentPulse } from "../../../hooks/useAgentPulse";
import { useInlineRename } from "../../../hooks/useInlineRename";
import { relativeShortThenDate } from "../../../utils/relative-time";
import { getDateBucket, type DateBucket } from "../../../utils/date-buckets";
import {
  filterModalRows,
  isRowOpen,
  listedAgents,
  mergeModalRows,
  projectChips,
  sessionRows,
  sessionTitle,
  type AgentTab,
  type ModalProject,
  type ModalRow,
} from "./agents-modal-list";
import { useAgentSearch } from "./useAgentSearch";
import { useModalSessions } from "./useModalSessions";
import styles from "./AgentsView.module.css";
import menuStyles from "../ProjectItem.module.css";

// ── Components ──

/** A row's project as a dot: its color, or a hollow ring when it has none. */
function ProjectDot({ project }: { project: ModalProject }) {
  return (
    <span
      className={styles.projectDot}
      data-uncolored={project.color ? undefined : ""}
      title={project.path ?? project.name}
      aria-label={project.name}
      role="img"
    />
  );
}

type ModalRowViewProps = {
  row: ModalRow;
  highlighted: boolean;
  /** The row's Agent has a pane in a workspace now: show its live status. */
  live: boolean;
  shouldPulse: boolean;
  /** Bumped to start renaming this row from the keyboard (F2); 0 for none. */
  renameToken: number;
  onHighlight: (rowId: string) => void;
  /** An inline rename ended, committed or not. */
  onRenameDone: () => void;
  onResumeAgent: (agent: AgentInfo) => void;
  onRemoveAgent: (agentId: string) => void;
  onRenameAgent: (agentId: string, name: string) => void;
};

/** The attributes every row shares, Agent or outside-Manor Session. */
function rowAttributes(row: ModalRow, highlighted: boolean, onHighlight: (rowId: string) => void) {
  return {
    role: "option",
    id: rowDomId(row.id),
    "aria-selected": highlighted,
    className: styles.agentRow,
    style: projectColorStyle(row.project.color),
    "data-highlighted": highlighted || undefined,
    "data-colored": row.project.color ? "" : undefined,
    "data-testid": "agents-modal-row",
    // Mouse movement, not enter: a list scrolled by the keyboard slides
    // rows under a still pointer, and that must not steal the highlight.
    onMouseMove: () => {
      if (!highlighted) onHighlight(row.id);
    },
  } as const;
}

function RowTime({ row }: { row: ModalRow }) {
  return (
    <span className={styles.agentTime}>
      {relativeShortThenDate(new Date(row.activityAt).getTime())}
    </span>
  );
}

const ModalRowView = memo(function ModalRowView(props: ModalRowViewProps) {
  const { row, highlighted, onHighlight } = props;
  if (row.agent) return <AgentRowView {...props} agent={row.agent} />;
  const title = row.session ? sessionTitle(row.session) : "Session";
  return (
    <div {...rowAttributes(row, highlighted, onHighlight)} data-outside="">
      <ProjectDot project={row.project} />
      <span className={styles.agentName} title={title} data-testid="agent-name">
        {title}
      </span>
      <Tooltip label="Found on disk; not started in Manor">
        <span
          className={styles.outsideMark}
          role="img"
          aria-label="Outside Manor"
          data-testid="agents-modal-outside"
        >
          <HardDrive size={11} />
        </span>
      </Tooltip>
      <RowTime row={row} />
    </div>
  );
});

function AgentRowView(props: ModalRowViewProps & { agent: AgentInfo }) {
  const {
    row,
    agent,
    highlighted,
    live,
    shouldPulse,
    renameToken,
    onHighlight,
    onRenameDone,
    onResumeAgent,
    onRemoveAgent,
    onRenameAgent,
  } = props;

  const display = useAgentDisplay(agent);
  const { status, reason } = display;
  // An Agent with no name of its own takes its Session's title.
  const title =
    display.title === "Agent" && !agent.name && row.session
      ? sessionTitle(row.session)
      : display.title;
  const rename = useInlineRename(
    title,
    (name) => onRenameAgent(agent.id, name),
    { emoji: true },
  );

  // `rename.start` is a new function each render; only a new token starts.
  const startRename = useRef(rename.start);
  startRename.current = rename.start;
  useEffect(() => {
    if (renameToken) startRename.current();
  }, [renameToken]);

  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !rename.editing) onRenameDone();
    wasEditing.current = rename.editing;
  }, [rename.editing, onRenameDone]);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          {...rowAttributes(row, highlighted, onHighlight)}
          data-agent-id={agent.id}
          onClick={() => {
            if (!rename.editing) onResumeAgent(agent);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            rename.start();
          }}
        >
          <ProjectDot project={row.project} />
          {rename.editing ? (
            <>
              <input
                className={`${menuStyles.workspaceNameInput} ${styles.agentNameInput}`}
                aria-label="Agent name"
                data-testid="agent-name-input"
                {...rename.inputProps}
              />
              {rename.suggestions}
            </>
          ) : (
            <span className={styles.agentName} title={title} data-testid="agent-name">{title}</span>
          )}
          {live && (
            <span className={styles.dotSlot}>
              <AgentDot status={status} size="sidebar" pulse={shouldPulse} reason={reason} />
            </span>
          )}
          <RowTime row={row} />
          <span
            role="button"
            aria-label="Remove agent"
            className={styles.removeButton}
            onClick={(e) => {
              e.stopPropagation();
              onRemoveAgent(agent.id);
            }}
          >
            <Trash2 size={12} />
          </span>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className={`${menuStyles.contextMenu} ${styles.rowMenu}`}
          {...rename.menuContentProps}
        >
          <ContextMenu.Item
            className={menuStyles.contextMenuItem}
            onSelect={() => rename.start()}
          >
            Rename Agent
          </ContextMenu.Item>
          <ContextMenu.Separator className={menuStyles.contextMenuSeparator} />
          <ContextMenu.Item
            className={`${menuStyles.contextMenuItem} ${menuStyles.contextMenuItemDanger}`}
            onSelect={() => onRemoveAgent(agent.id)}
          >
            Remove Agent
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** A row's DOM id, for the search box's `aria-activedescendant`. */
function rowDomId(rowId: string): string {
  return `agents-modal-row-${rowId}`;
}

const TABS: { id: AgentTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "closed", label: "Closed" },
];

/** How many search matches the list draws; typing more narrows the rest. */
const MAX_SEARCH_ROWS = 300;

/** How many rows the plain list draws at a time; scrolling to the end draws more. */
const LIST_ROWS_STEP = 200;

function emptyMessage(query: string, tab: AgentTab, project: ModalProject | null): string {
  if (query.trim()) return `No sessions match “${query.trim()}”`;
  if (project) return `Nothing in ${project.name} here.`;
  if (tab === "open") return "No open agents.";
  if (tab === "closed") return "No closed agents.";
  return "No agents found.";
}

// ── Modal Component ──

type AgentsModalProps = {
  open: boolean;
  onClose: () => void;
  onResumeAgent: (agent: AgentInfo) => void;
};

export function AgentsModal(props: AgentsModalProps) {
  const { open, onClose, onResumeAgent } = props;

  const { onCloseAutoFocus: restoreFocusOnClose } = useRestoreFocus(open);

  const {
    agents,
    loading,
    loaded,
    hasMore,
    loadingMore,
    removeAgent,
    renameAgent,
    loadMoreAgents,
  } = useAgentStore();
  const shouldPulse = useAgentPulse();
  const [tab, setTab] = useState<AgentTab>("all");
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState<ModalProject | null>(null);
  const [listLimit, setListLimit] = useState(LIST_ROWS_STEP);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; token: number } | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const searching = query.trim() !== "";
  const search = useAgentSearch(open ? query : "");
  const disk = useModalSessions(open);
  const openPaneIds = useOpenPaneIds(open);
  const liveTitles = useCleanPaneTitles(open && searching);
  const projects = useProjectStore((s) => s.projects);

  // Each opening starts from an empty search over every project.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setProjectFilter(null);
    setListLimit(LIST_ROWS_STEP);
  }, [open]);

  // Project matching over every Session runs only when the Sessions or the
  // projects' paths, names or colors change, not on every Agent update.
  const projectsKey = projects
    .map((p) => [p.id, p.hostId, p.name, p.color, p.path, ...p.workspaces.map((w) => w.path)].join("\0"))
    .join("\n");
  const sessionBase = useMemo(() => sessionRows(disk.sessions, projects), [disk.sessions, projectsKey]);
  const shownAgents = useMemo(
    () => listedAgents(agents, search.agents, query),
    [agents, search.agents, query],
  );
  // Rows whose Agent, Session and project are unchanged keep their object,
  // so the memoized rows don't redraw on another Agent's update.
  const previousRows = useRef<ReadonlyMap<string, ModalRow>>(new Map());
  const mergedRows = useMemo(() => {
    const merged = mergeModalRows(
      { sessions: sessionBase, agents: shownAgents, knownAgents: disk.knownAgents },
      previousRows.current,
    );
    previousRows.current = new Map(merged.map((r) => [r.id, r]));
    return merged;
  }, [sessionBase, shownAgents, disk.knownAgents]);
  const tabRows = useMemo(
    () => filterModalRows(mergedRows, { query, tab, openPaneIds, liveTitles }),
    [mergedRows, query, tab, openPaneIds, liveTitles],
  );
  const chips = useMemo(() => projectChips(tabRows, projectFilter), [tabRows, projectFilter]);
  const allRows = useMemo(
    () => (projectFilter ? tabRows.filter((r) => r.project.key === projectFilter.key) : tabRows),
    [tabRows, projectFilter],
  );
  const rows = allRows.slice(0, searching ? MAX_SEARCH_ROWS : listLimit);

  // The highlight follows its row; when that row leaves the list (a new
  // search, another tab or project) it falls back to the first row.
  const highlighted =
    rows.find((r) => r.id === highlightedId) ?? rows[0] ?? null;

  const scrollToRow = useCallback((rowId: string) => {
    document
      .getElementById(rowDomId(rowId))
      ?.scrollIntoView({ block: "nearest" });
  }, []);

  const handleResume = useCallback(
    (agent: AgentInfo) => {
      onClose();
      onResumeAgent(agent);
    },
    [onClose, onResumeAgent],
  );

  const focusSearch = useCallback(() => searchRef.current?.focus(), []);

  const { forget } = search;
  const { forget: forgetKnown, rename: renameKnown } = disk;
  const handleRemove = useCallback(
    (agentId: string) => {
      void removeAgent(agentId)
        .then((removed) => {
          if (!removed) return;
          forget(agentId);
          forgetKnown(agentId);
        })
        .catch(() => {});
      focusSearch();
    },
    [removeAgent, forget, forgetKnown, focusSearch],
  );

  const handleRename = useCallback(
    (agentId: string, name: string) => {
      void renameAgent(agentId, name);
      renameKnown(agentId, name);
    },
    [renameAgent, renameKnown],
  );

  // Rename, remove and resume act on Agents; a Session from outside Manor
  // has none of them here.
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const index = highlighted ? rows.indexOf(highlighted) : -1;
    const agent = highlighted?.agent;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = rows[e.key === "ArrowDown" ? index + 1 : index - 1];
      if (!next) return;
      setHighlightedId(next.id);
      scrollToRow(next.id);
    } else if (e.key === "Enter" && highlighted) {
      e.preventDefault();
      if (agent) handleResume(agent);
    } else if (e.key === "F2" && highlighted) {
      e.preventDefault();
      if (agent) setRenameTarget((t) => ({ id: agent.id, token: (t?.token ?? 0) + 1 }));
    } else if (e.key === "Backspace" && (e.metaKey || e.ctrlKey) && highlighted) {
      e.preventDefault();
      if (agent) handleRemove(agent.id);
    }
  };

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) onClose();
    },
    [onClose],
  );

  // A search asks main for every match at once and caps what it draws; the
  // plain list draws a window of rows and pages Agents in from main.
  const rowsHidden = !searching && allRows.length > rows.length;
  const listHasMore = !searching && (hasMore || rowsHidden);
  const loadMoreRef = useRef(() => {});
  loadMoreRef.current = () => {
    if (rowsHidden) setListLimit((n) => n + LIST_ROWS_STEP);
    else void loadMoreAgents(agents.length);
  };

  // When the bottom sentinel scrolls into view, draw or request more.
  // The store coalesces overlapping calls and stops once nothing is left,
  // so the observer firing more than once is safe. Rebuilt after every page,
  // even one that adds no row to this tab, so a sentinel still in view asks
  // again.
  useEffect(() => {
    if (!open) return;
    if (!listHasMore) return;
    const node = sentinelRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMoreRef.current();
      },
      { root: listRef.current, rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [open, listHasMore, agents.length, rows.length]);

  // Rows arrive newest first, so each date bucket is one contiguous run.
  const groups: { bucket: DateBucket; rows: ModalRow[] }[] = [];
  for (const row of rows) {
    const bucket = getDateBucket(row.activityAt);
    const last = groups[groups.length - 1];
    if (last?.bucket === bucket) last.rows.push(row);
    else groups.push({ bucket, rows: [row] });
  }

  // Fade whichever edge of the chip row has chips scrolled past it.
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const [chipFade, setChipFade] = useState({ start: false, end: false });
  const updateChipFade = useCallback(() => {
    const el = chipsRef.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setChipFade((f) => (f.start === start && f.end === end ? f : { start, end }));
  }, []);
  useLayoutEffect(updateChipFade, [chips, updateChipFade]);
  useEffect(() => {
    const el = chipsRef.current;
    if (!el) return;
    const observer = new ResizeObserver(updateChipFade);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, chips.length > 0, updateChipFade]);

  const pickProject = (project: ModalProject | null) => {
    setProjectFilter(project);
    searchRef.current?.focus();
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.modal}
          data-testid="agents-modal"
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            searchRef.current?.focus();
          }}
          onCloseAutoFocus={restoreFocusOnClose}
        >
          <Dialog.Title className="sr-only">Agents</Dialog.Title>
          <div className={styles.header}>
            <Search size={15} className={styles.searchIcon} aria-hidden />
            <input
              ref={searchRef}
              className={styles.searchInput}
              data-testid="agents-modal-search"
              placeholder="Search agents…"
              aria-label="Search agents"
              role="combobox"
              aria-expanded
              aria-controls="agents-modal-list"
              aria-activedescendant={highlighted ? rowDomId(highlighted.id) : undefined}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
            <div className={styles.filterTabs} role="group" aria-label="Show">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`${styles.filterTab} ${tab === t.id ? styles.filterTabActive : ""}`}
                  aria-pressed={tab === t.id}
                  data-testid={`agents-modal-tab-${t.id}`}
                  onClick={() => {
                    setTab(t.id);
                    searchRef.current?.focus();
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <Dialog.Close asChild>
              <button className={styles.closeButton} aria-label="Close">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          {chips.length > 0 && (
            <div
              ref={chipsRef}
              className={styles.chips}
              role="group"
              aria-label="Project"
              data-fade-start={chipFade.start || undefined}
              data-fade-end={chipFade.end || undefined}
              onScroll={updateChipFade}
              onWheel={(e) => {
                // A mouse wheel scrolls the one row of chips sideways.
                const el = e.currentTarget;
                if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
              }}
            >
              <button
                type="button"
                className={styles.chip}
                aria-pressed={!projectFilter}
                data-testid="agents-modal-chip"
                onClick={() => pickProject(null)}
              >
                All projects
              </button>
              {chips.map(({ project: p, label }) => (
                <button
                  key={p.key}
                  type="button"
                  className={styles.chip}
                  style={projectColorStyle(p.color)}
                  aria-pressed={projectFilter?.key === p.key}
                  data-testid="agents-modal-chip"
                  data-project-key={p.key}
                  title={p.path}
                  onClick={() => pickProject(p)}
                >
                  <span
                    className={styles.projectDot}
                    data-uncolored={p.color ? undefined : ""}
                    aria-hidden
                  />
                  {label}
                </button>
              ))}
            </div>
          )}

          <div
            ref={listRef}
            className={styles.scrollArea}
            id="agents-modal-list"
            role="listbox"
            aria-label="Agents"
          >
            {loading && !loaded && (
              <div className={styles.loading}>Loading agents...</div>
            )}

            {loaded && rows.length === 0 && (
              <div className={styles.empty} data-testid="agents-modal-empty">
                {emptyMessage(query, tab, projectFilter)}
              </div>
            )}

            {groups.map(({ bucket, rows: bucketRows }) => (
              <div key={bucket} className={styles.dateGroup} role="group" aria-label={bucket}>
                <div className={styles.dateGroupHeader}>{bucket}</div>
                {bucketRows.map((row) => (
                  <ModalRowView
                    key={row.id}
                    row={row}
                    highlighted={row.id === highlighted?.id}
                    live={isRowOpen(row, openPaneIds)}
                    shouldPulse={row.agent ? shouldPulse(row.agent) : false}
                    renameToken={renameTarget?.id === row.id ? renameTarget.token : 0}
                    onHighlight={setHighlightedId}
                    onRenameDone={focusSearch}
                    onResumeAgent={handleResume}
                    onRemoveAgent={handleRemove}
                    onRenameAgent={handleRename}
                  />
                ))}
              </div>
            ))}

            {searching && allRows.length > rows.length && (
              <div className={styles.loadMore}>
                Showing the first {MAX_SEARCH_ROWS} matches. Keep typing to narrow them.
              </div>
            )}

            {listHasMore && (
              <div
                ref={sentinelRef}
                data-testid="agents-load-more-sentinel"
                className={styles.loadMore}
                aria-hidden="true"
              >
                {loadingMore ? "Loading more..." : ""}
              </div>
            )}
          </div>

          <div className={styles.footer} aria-hidden="true">
            <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
            <span><kbd>↵</kbd> resume</span>
            <span><kbd>F2</kbd> rename</span>
            <span className={styles.footerEnd}><kbd>esc</kbd> close</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
