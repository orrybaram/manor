import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Command } from "cmdk";
import { IssueListSkeleton } from "./IssueListSkeleton";
import styles from "./CommandPalette.module.css";

type GitHubIssuesViewProps = {
  repoPath: string;
  allIssues?: boolean;
  onSelectIssue: (issueNumber: number) => void;
  onEmptyChange?: (empty: boolean) => void;
};

export function GitHubIssuesView(props: GitHubIssuesViewProps) {
  const { repoPath, allIssues, onSelectIssue, onEmptyChange } = props;

  const { data: issues = [], isLoading } = useQuery({
    queryKey: ["github-issues", repoPath, allIssues],
    queryFn: () =>
      allIssues
        ? window.electronAPI.github.getAllIssues(repoPath, 50)
        : window.electronAPI.github.getMyIssues(repoPath, 50),
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

  if (isLoading) {
    return <IssueListSkeleton />;
  }

  if (isEmpty) {
    return <div className={styles.empty}>No issues found</div>;
  }

  return (
    <Command.Group
      heading={allIssues ? "All Issues" : "My Issues"}
      className={styles.group}
    >
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
  );
}
