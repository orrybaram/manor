import { useState, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Command } from "cmdk";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import { IssueListSkeleton } from "./IssueListSkeleton";
import styles from "./CommandPalette.module.css";

const STATE_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
] as const;

type GitHubIssuesViewProps = {
  repoPath: string;
  onSelectIssue: (issueNumber: number) => void;
  onEmptyChange?: (empty: boolean) => void;
};

export function GitHubIssuesView(props: GitHubIssuesViewProps) {
  const { repoPath, onSelectIssue, onEmptyChange } = props;

  const [myIssues, setMyIssues] = useState(true);
  const [stateFilter, setStateFilter] = useState<string[]>(["open"]);
  const [statusOpen, setStatusOpen] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);

  const toggleState = useCallback((state: string) => {
    setStateFilter((prev) => {
      if (prev.includes(state)) {
        if (prev.length === 1) return prev; // Don't allow empty
        return prev.filter((s) => s !== state);
      }
      return [...prev, state];
    });
  }, []);

  // Map selected states to the gh CLI state parameter
  const ghState: "open" | "closed" | "all" =
    stateFilter.length === STATE_OPTIONS.length
      ? "all"
      : (stateFilter[0] as "open" | "closed");

  const { data: issues = [], isLoading } = useQuery({
    queryKey: ["github-issues", repoPath, myIssues, ghState],
    queryFn: () =>
      myIssues
        ? window.electronAPI.github.getMyIssues(repoPath, 50, ghState)
        : window.electronAPI.github.getAllIssues(repoPath, 50, ghState),
    enabled: !!repoPath,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const isEmpty = !isLoading && issues.length === 0;

  const prevEmptyRef = useRef<boolean | undefined>(undefined);
  if (isEmpty !== prevEmptyRef.current) {
    prevEmptyRef.current = isEmpty;
    onEmptyChange?.(isEmpty);
  }

  const handleStatusBlur = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    if (!statusRef.current?.contains(e.relatedTarget as Node)) {
      setStatusOpen(false);
    }
  }, []);

  const statusLabel =
    stateFilter.length === STATE_OPTIONS.length
      ? "All States"
      : stateFilter
          .map((s) => STATE_OPTIONS.find((o) => o.value === s)?.label ?? s)
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
              {STATE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  className={`${styles.filterMenuItem} ${stateFilter.includes(opt.value) ? styles.filterMenuItemActive : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    toggleState(opt.value);
                  }}
                >
                  <span className={styles.filterCheck}>
                    {stateFilter.includes(opt.value) ? "\u2713" : ""}
                  </span>
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {isLoading ? (
        <IssueListSkeleton />
      ) : isEmpty ? (
        <div className={styles.empty}>No issues found</div>
      ) : (
        <Command.Group className={styles.group}>
          {issues.map((issue) => (
            <Command.Item
              key={issue.number}
              value={`#${issue.number} ${issue.title}`}
              onSelect={() => onSelectIssue(issue.number)}
              className={styles.item}
            >
              <span className={styles.issueIdentifier}>#{issue.number}</span>
              <span className={styles.label}>{issue.title}</span>
              <span className={styles.issueState}>{issue.state}</span>
            </Command.Item>
          ))}
        </Command.Group>
      )}
    </>
  );
}
