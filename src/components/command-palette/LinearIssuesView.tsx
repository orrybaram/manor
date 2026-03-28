import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Command } from "cmdk";
import { IssueListSkeleton } from "./IssueListSkeleton";
import styles from "./CommandPalette.module.css";

type LinearIssuesViewProps = {
  allTeamIds: string[];
  allIssues?: boolean;
  onSelectIssue: (issueId: string) => void;
  onEmptyChange?: (empty: boolean) => void;
};

export function LinearIssuesView(props: LinearIssuesViewProps) {
  const { allTeamIds, allIssues, onSelectIssue, onEmptyChange } = props;

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
