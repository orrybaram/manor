import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Command } from "cmdk";
import { IssueListSkeleton } from "./IssueListSkeleton";
import styles from "./CommandPalette.module.css";

interface LinearIssuesViewProps {
  allTeamIds: string[];
  allIssues?: boolean;
  onSelectIssue: (issueId: string) => void;
  onEmptyChange?: (empty: boolean) => void;
}

export function LinearIssuesView({
  allTeamIds,
  allIssues,
  onSelectIssue,
  onEmptyChange,
}: LinearIssuesViewProps) {
  const { data: linearIssues = [], isLoading } = useQuery({
    queryKey: [allIssues ? "linear-all-issues" : "linear-issues", allTeamIds],
    queryFn: () =>
      allIssues
        ? window.electronAPI.linear.getAllIssues(allTeamIds, {
            stateTypes: ["unstarted", "backlog"],
            limit: 50,
          })
        : window.electronAPI.linear.getMyIssues(allTeamIds, {
            stateTypes: ["unstarted", "backlog"],
            limit: 50,
          }),
    enabled: allTeamIds.length > 0,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const isEmpty = !isLoading && linearIssues.length === 0;

  useEffect(() => {
    onEmptyChange?.(isEmpty);
  }, [isEmpty, onEmptyChange]);

  if (isLoading) {
    return <IssueListSkeleton />;
  }

  if (isEmpty) {
    return (
      <div className={styles.empty}>No issues found</div>
    );
  }

  return (
    <Command.Group heading={allIssues ? "All Issues" : "My Issues"} className={styles.group}>
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
  );
}
