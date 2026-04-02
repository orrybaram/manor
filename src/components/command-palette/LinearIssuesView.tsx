import { useState, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Command } from "cmdk";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import { IssueListSkeleton } from "./IssueListSkeleton";
import styles from "./CommandPalette.module.css";

const STATUS_OPTIONS = [
  { value: "unstarted", label: "Todo" },
  { value: "backlog", label: "Backlog" },
  { value: "started", label: "In Progress" },
] as const;

const PRIORITY_OPTIONS = [
  { value: 0, label: "All Priorities" },
  { value: 1, label: "Urgent" },
  { value: 2, label: "High" },
  { value: 3, label: "Medium" },
  { value: 4, label: "Low" },
] as const;

type LinearIssuesViewProps = {
  allTeamIds: string[];
  onSelectIssue: (issueId: string) => void;
  onEmptyChange?: (empty: boolean) => void;
};

export function LinearIssuesView(props: LinearIssuesViewProps) {
  const { allTeamIds, onSelectIssue, onEmptyChange } = props;

  const [myIssues, setMyIssues] = useState(true);
  const [stateTypes, setStateTypes] = useState<string[]>(["unstarted", "backlog"]);
  const [priority, setPriority] = useState<number | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);

  const toggleStateType = useCallback((type: string) => {
    setStateTypes((prev) => {
      if (prev.includes(type)) {
        if (prev.length === 1) return prev; // Don't allow empty
        return prev.filter((t) => t !== type);
      }
      return [...prev, type];
    });
  }, []);

  const { data: linearIssues = [], isLoading } = useQuery({
    queryKey: ["linear-issues", allTeamIds, myIssues, stateTypes, priority],
    queryFn: async () => {
      const issues = myIssues
        ? await window.electronAPI.linear.getMyIssues(allTeamIds, {
            stateTypes,
            limit: 50,
          })
        : await window.electronAPI.linear.getAllIssues(allTeamIds, {
            stateTypes,
            limit: 50,
          });
      if (priority !== null) {
        return issues.filter((i) => i.priority === priority);
      }
      return issues;
    },
    enabled: allTeamIds.length > 0,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const isEmpty = !isLoading && linearIssues.length === 0;

  const prevEmptyRef = useRef<boolean | undefined>(undefined);
  if (isEmpty !== prevEmptyRef.current) {
    prevEmptyRef.current = isEmpty;
    onEmptyChange?.(isEmpty);
  }

  // Close status dropdown when clicking outside
  const handleStatusBlur = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    if (!statusRef.current?.contains(e.relatedTarget as Node)) {
      setStatusOpen(false);
    }
  }, []);

  const statusLabel =
    stateTypes.length === STATUS_OPTIONS.length
      ? "All Statuses"
      : stateTypes
          .map((t) => STATUS_OPTIONS.find((o) => o.value === t)?.label ?? t)
          .join(", ");

  return (
    <>
      <div className={styles.filterBar}>
        <button
          className={`${styles.filterToggle} ${myIssues ? styles.filterToggleActive : ""}`}
          onClick={() => setMyIssues((v) => !v)}
        >
          My Issues
        </button>

        <div
          className={styles.filterDropdown}
          ref={statusRef}
          onBlur={handleStatusBlur}
        >
          <button
            className={styles.filterButton}
            onClick={() => setStatusOpen((v) => !v)}
          >
            {statusLabel}
            <ChevronDown size={12} />
          </button>
          {statusOpen && (
            <div className={styles.filterMenu}>
              {STATUS_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  className={`${styles.filterMenuItem} ${stateTypes.includes(opt.value) ? styles.filterMenuItemActive : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    toggleStateType(opt.value);
                  }}
                >
                  <span className={styles.filterCheck}>
                    {stateTypes.includes(opt.value) ? "\u2713" : ""}
                  </span>
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className={styles.filterDropdown}>
          <select
            className={styles.filterSelect}
            value={priority ?? ""}
            onChange={(e) =>
              setPriority(e.target.value === "" ? null : Number(e.target.value))
            }
          >
            {PRIORITY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value === 0 ? "" : opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isLoading ? (
        <IssueListSkeleton />
      ) : isEmpty ? (
        <div className={styles.empty}>No issues found</div>
      ) : (
        <Command.Group className={styles.group}>
          {linearIssues.map((issue) => (
            <Command.Item
              key={issue.id}
              value={`${issue.identifier} ${issue.title}`}
              onSelect={() => onSelectIssue(issue.id)}
              className={styles.item}
            >
              <span className={styles.issueIdentifier}>{issue.identifier}</span>
              <span className={styles.label}>{issue.title}</span>
              <span className={styles.issueState}>{issue.state.name}</span>
            </Command.Item>
          ))}
        </Command.Group>
      )}
    </>
  );
}
