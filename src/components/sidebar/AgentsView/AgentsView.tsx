import { useState, useCallback, useEffect, useRef, memo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import X from "lucide-react/dist/esm/icons/x";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import type { AgentInfo } from "../../../electron.d";
import { useAgentStore } from "../../../store/agent-store";
import { AgentDot } from "../../ui/AgentDot/AgentDot";
import { useAgentDisplay } from "../../../hooks/useAgentDisplay";
import { relativeShortThenDate } from "../../../utils/relative-time";
import { BUCKET_ORDER, getDateBucket, type DateBucket } from "../../../utils/date-buckets";
import styles from "./AgentsView.module.css";

// ── Helpers ──

type StatusFilter = "all" | "active" | "completed";

function matchesFilter(agent: AgentInfo, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return agent.status === "active";
  if (filter === "completed")
    return (
      agent.status === "completed" ||
      agent.status === "error" ||
      agent.status === "abandoned"
    );
  return true;
}

// ── Components ──

type AgentViewRowProps = {
  agent: AgentInfo;
  onResumeAgent: (agent: AgentInfo) => void;
  onRemoveAgent: (agentId: string) => void;
};

const AgentViewRow = memo(function AgentViewRow(props: AgentViewRowProps) {
  const { agent, onResumeAgent, onRemoveAgent } = props;

  const { title, status } = useAgentDisplay(agent);

  return (
    <button className={styles.agentRow} onClick={() => onResumeAgent(agent)}>
      <AgentDot status={status} size="sidebar" />
      <span className={styles.agentName}>{title}</span>
      <span className={styles.agentProject}>
        {agent.projectName || "No Project"}
      </span>
      <span className={styles.agentTime}>
        {relativeShortThenDate(new Date(agent.updatedAt).getTime())}
      </span>
      <span
        role="button"
        tabIndex={0}
        className={styles.removeButton}
        onClick={(e) => {
          e.stopPropagation();
          onRemoveAgent(agent.id);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            onRemoveAgent(agent.id);
          }
        }}
      >
        <Trash2 size={12} />
      </span>
    </button>
  );
});

// ── Modal Component ──

type AgentsModalProps = {
  open: boolean;
  onClose: () => void;
  onResumeAgent: (agent: AgentInfo) => void;
};

export function AgentsModal(props: AgentsModalProps) {
  const { open, onClose, onResumeAgent } = props;

  const {
    agents,
    loading,
    loaded,
    hasMore,
    loadingMore,
    removeAgent,
    loadMoreAgents,
  } = useAgentStore();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const handleResume = useCallback(
    (agent: AgentInfo) => {
      onClose();
      onResumeAgent(agent);
    },
    [onClose, onResumeAgent],
  );

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) onClose();
    },
    [onClose],
  );

  // When the bottom sentinel scrolls into view, request the next page.
  // The store's `loadMoreAgents` coalesces overlapping calls and short-circuits
  // when `hasMore` is false, so the observer firing more than once is safe.
  useEffect(() => {
    if (!open) return;
    if (!hasMore) return;
    const node = sentinelRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            loadMoreAgents(agents.length);
            break;
          }
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [open, hasMore, agents.length, loadMoreAgents]);

  const filtered = agents.filter((t) => matchesFilter(t, filter));

  // Group by date bucket, then by project within each bucket
  const grouped = new Map<DateBucket, Map<string, AgentInfo[]>>();

  for (const agent of filtered) {
    const bucket = getDateBucket(agent.createdAt);
    let projectMap = grouped.get(bucket);
    if (!projectMap) {
      projectMap = new Map<string, AgentInfo[]>();
      grouped.set(bucket, projectMap);
    }
    const projectKey = agent.projectName || "No Project";
    let list = projectMap.get(projectKey);
    if (!list) {
      list = [];
      projectMap.set(projectKey, list);
    }
    list.push(agent);
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.modal}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            document
              .querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
              ?.focus();
          }}
        >
          <div className={styles.header}>
            <Dialog.Title className={styles.title}>Agents</Dialog.Title>
            <div className={styles.filterTabs}>
              {(["all", "active", "completed"] as const).map((f) => (
                <button
                  key={f}
                  className={`${styles.filterTab} ${filter === f ? styles.filterTabActive : ""}`}
                  onClick={() => setFilter(f)}
                >
                  {f === "all"
                    ? "All"
                    : f === "active"
                      ? "Active"
                      : "Completed"}
                </button>
              ))}
            </div>
            <Dialog.Close asChild>
              <button className={styles.closeButton}>
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <div className={styles.scrollArea}>
            {loading && !loaded && (
              <div className={styles.loading}>Loading agents...</div>
            )}

            {loaded && filtered.length === 0 && (
              <div className={styles.empty}>No agents found.</div>
            )}

            {BUCKET_ORDER.map((bucket) => {
              const projectMap = grouped.get(bucket);
              if (!projectMap) return null;

              return (
                <div key={bucket} className={styles.dateGroup}>
                  <div className={styles.dateGroupHeader}>{bucket}</div>
                  {Array.from(projectMap.entries()).map(
                    ([projectName, projectAgents]) => (
                      <div key={projectName} className={styles.projectGroup}>
                        <div className={styles.projectGroupHeader}>
                          {projectName}
                        </div>
                        {projectAgents.map((agent) => (
                          <AgentViewRow
                            key={agent.id}
                            agent={agent}
                            onResumeAgent={handleResume}
                            onRemoveAgent={removeAgent}
                          />
                        ))}
                      </div>
                    ),
                  )}
                </div>
              );
            })}

            {hasMore && (
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
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
