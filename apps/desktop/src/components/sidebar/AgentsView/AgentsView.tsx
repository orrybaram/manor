import { useState, useCallback, useEffect, useMemo, useRef, memo, type CSSProperties } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as ContextMenu from "@radix-ui/react-context-menu";
import X from "lucide-react/dist/esm/icons/x";
import Search from "lucide-react/dist/esm/icons/search";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import type { AgentInfo } from "../../../electron.d";
import { useAgentStore } from "../../../store/agent-store";
import { useRestoreFocus } from "../../../hooks/useRestoreFocus";
import { AgentDot } from "../../ui/AgentDot/AgentDot";
import { useAgentDisplay, useCleanPaneTitles } from "../../../hooks/useAgentDisplay";
import { useOpenPaneIds } from "../../../hooks/useOpenPaneIds";
import { projectColorStyle } from "../../../hooks/useProjectHeaderRow";
import { useProjectStore } from "../../../store/project-store";
import { useAgentPulse } from "../../../hooks/useAgentPulse";
import { useInlineRename } from "../../../hooks/useInlineRename";
import { relativeShortThenDate } from "../../../utils/relative-time";
import { getDateBucket, type DateBucket } from "../../../utils/date-buckets";
import { agentsModalRows, type AgentTab } from "./agents-modal-list";
import { useAgentSearch } from "./useAgentSearch";
import styles from "./AgentsView.module.css";
import menuStyles from "../ProjectItem.module.css";

// ── Components ──

type AgentViewRowProps = {
  agent: AgentInfo;
  highlighted: boolean;
  /** The agent's project color, as `projectColorStyle` gives it. */
  colorStyle: CSSProperties | undefined;
  shouldPulse: boolean;
  onHighlight: (agentId: string) => void;
  onResumeAgent: (agent: AgentInfo) => void;
  onRemoveAgent: (agentId: string) => void;
  onRenameAgent: (agentId: string, name: string) => void;
};

const AgentViewRow = memo(function AgentViewRow(props: AgentViewRowProps) {
  const {
    agent,
    highlighted,
    colorStyle,
    shouldPulse,
    onHighlight,
    onResumeAgent,
    onRemoveAgent,
    onRenameAgent,
  } = props;

  const { title, status, reason } = useAgentDisplay(agent);
  const rename = useInlineRename(
    title,
    (name) => onRenameAgent(agent.id, name),
    { emoji: true },
  );

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          role="option"
          id={rowDomId(agent.id)}
          aria-selected={highlighted}
          className={styles.agentRow}
          style={colorStyle}
          data-highlighted={highlighted || undefined}
          data-colored={colorStyle ? "" : undefined}
          data-testid="agents-modal-row"
          data-agent-id={agent.id}
          // Mouse movement, not enter: a list scrolled by the keyboard slides
          // rows under a still pointer, and that must not steal the highlight.
          onMouseMove={() => {
            if (!highlighted) onHighlight(agent.id);
          }}
          onClick={() => {
            if (!rename.editing) onResumeAgent(agent);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            rename.start();
          }}
        >
          <AgentDot
            status={status}
            size="sidebar"
            pulse={shouldPulse}
            reason={reason}
          />
          <span className={styles.agentProject} title={agent.projectName ?? undefined}>
            {agent.projectName || "No project"}
          </span>
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
          <span className={styles.agentTime}>
            {relativeShortThenDate(new Date(agent.updatedAt).getTime())}
          </span>
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
});

/** A row's DOM id, for the search box's `aria-activedescendant`. */
function rowDomId(agentId: string): string {
  return `agents-modal-row-${agentId}`;
}

const TABS: { id: AgentTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "closed", label: "Closed" },
];

function emptyMessage(query: string, tab: AgentTab): string {
  if (query.trim()) return `No agents match “${query.trim()}”`;
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
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const searching = query.trim() !== "";
  const search = useAgentSearch(open ? query : "");
  const openPaneIds = useOpenPaneIds(open);
  const liveTitles = useCleanPaneTitles(open && searching);
  const projects = useProjectStore((s) => s.projects);

  // Each opening starts from an empty search.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const rows = useMemo(
    () =>
      agentsModalRows({
        storeAgents: agents,
        searchAgents: search.agents,
        query,
        tab,
        openPaneIds,
        liveTitles,
      }),
    [agents, search.agents, query, tab, openPaneIds, liveTitles],
  );

  const colorStyles = useMemo(() => {
    const byId = new Map<string, CSSProperties | undefined>();
    for (const p of projects) byId.set(p.id, projectColorStyle(p.color));
    return byId;
  }, [projects]);

  // The highlight follows its agent; when that agent leaves the list (a new
  // search, another tab) it falls back to the first row.
  const highlighted =
    rows.find((a) => a.id === highlightedId) ?? rows[0] ?? null;

  const scrollToRow = useCallback((agentId: string) => {
    document
      .getElementById(rowDomId(agentId))
      ?.scrollIntoView({ block: "nearest" });
  }, []);

  const handleResume = useCallback(
    (agent: AgentInfo) => {
      onClose();
      onResumeAgent(agent);
    },
    [onClose, onResumeAgent],
  );

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const index = highlighted ? rows.indexOf(highlighted) : -1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = rows[e.key === "ArrowDown" ? index + 1 : index - 1];
      if (!next) return;
      setHighlightedId(next.id);
      scrollToRow(next.id);
    } else if (e.key === "Enter" && highlighted) {
      e.preventDefault();
      handleResume(highlighted);
    }
  };

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) onClose();
    },
    [onClose],
  );

  const listHasMore = searching ? search.hasMore : hasMore;
  const loadMore = searching
    ? search.loadMore
    : () => loadMoreAgents(agents.length);
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  // When the bottom sentinel scrolls into view, request the next page.
  // Both loaders coalesce overlapping calls and stop once nothing is left,
  // so the observer firing more than once is safe.
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
  }, [open, listHasMore, rows.length]);

  // Rows arrive newest first, so each date bucket is one contiguous run.
  const groups: { bucket: DateBucket; agents: AgentInfo[] }[] = [];
  for (const agent of rows) {
    const bucket = getDateBucket(agent.createdAt);
    const last = groups[groups.length - 1];
    if (last?.bucket === bucket) last.agents.push(agent);
    else groups.push({ bucket, agents: [agent] });
  }

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
                {emptyMessage(query, tab)}
              </div>
            )}

            {groups.map(({ bucket, agents: bucketAgents }) => (
              <div key={bucket} className={styles.dateGroup} role="group" aria-label={bucket}>
                <div className={styles.dateGroupHeader}>{bucket}</div>
                {bucketAgents.map((agent) => (
                  <AgentViewRow
                    key={agent.id}
                    agent={agent}
                    highlighted={agent.id === highlighted?.id}
                    colorStyle={agent.projectId ? colorStyles.get(agent.projectId) : undefined}
                    shouldPulse={shouldPulse(agent)}
                    onHighlight={setHighlightedId}
                    onResumeAgent={handleResume}
                    onRemoveAgent={removeAgent}
                    onRenameAgent={renameAgent}
                  />
                ))}
              </div>
            ))}

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
            <span className={styles.footerEnd}><kbd>esc</kbd> close</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
