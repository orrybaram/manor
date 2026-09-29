import { useMemo, useRef } from "react";
import { Command } from "cmdk";
import { IssueListSkeleton } from "./IssueListSkeleton";
import { GitHubIcon } from "./GitHubIcon";
import { LinearIcon } from "./LinearIcon";
import { useUpNextIssues, type UpNextRow } from "../sidebar/HomeDashboard/useUpNextIssues";
import { useStartUpNextIssue } from "../sidebar/HomeDashboard/useStartUpNextIssue";
import type { NewWorkspaceHandler } from "../../lib/start-issue-work";
import styles from "./CommandPalette.module.css";

type UpNextViewProps = {
  onNewWorkspace?: NewWorkspaceHandler;
  onClose: () => void;
  onEmptyChange?: (empty: boolean) => void;
};

/** `rows` split per top-level entry, groups in the order their first row appears. */
function groupByProject(rows: readonly UpNextRow[]): { key: string; name: string; rows: UpNextRow[] }[] {
  const groups = new Map<string, { key: string; name: string; rows: UpNextRow[] }>();
  for (const row of rows) {
    const key = row.issue.projectKey;
    let group = groups.get(key);
    if (!group) {
      group = { key, name: row.entryName, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()];
}

/**
 * Every Up next issue — the full list Home's "N issues ready" counts — grouped
 * per project (ADR-197 §2). Selecting one starts work on it, as Home's rows do.
 */
export function UpNextView(props: UpNextViewProps) {
  const { onNewWorkspace, onClose, onEmptyChange } = props;
  const upNext = useUpNextIssues();
  const startIssue = useStartUpNextIssue(onNewWorkspace);

  const groups = useMemo(() => groupByProject(upNext.all), [upNext.all]);

  const isLoading = upNext.loading && upNext.all.length === 0;
  const isEmpty = !upNext.loading && upNext.all.length === 0;

  const prevEmptyRef = useRef<boolean | undefined>(undefined);
  if (isEmpty !== prevEmptyRef.current) {
    prevEmptyRef.current = isEmpty;
    onEmptyChange?.(isEmpty);
  }

  if (isLoading) return <IssueListSkeleton />;
  if (isEmpty) return <div className={styles.empty}>No issues found</div>;

  return (
    <>
      {groups.map((group) => (
        <Command.Group key={group.key} heading={group.name} className={styles.group}>
          {group.rows.map((row) => (
            <Command.Item
              key={`${row.issue.source}:${row.issue.url}`}
              value={`${row.issue.identifier} ${row.issue.title} ${row.entryName}`}
              onSelect={() => {
                // Close now, like the issue detail views: the New Workspace
                // dialog opens once the issue body is fetched.
                void startIssue(row);
                onClose();
              }}
              className={styles.item}
            >
              <span className={styles.icon}>
                {row.issue.source === "github" ? <GitHubIcon size={14} /> : <LinearIcon size={14} />}
              </span>
              <span className={styles.issueIdentifier}>{row.issue.identifier}</span>
              <span className={styles.label}>{row.issue.title}</span>
              {row.issue.labels.includes("ready-for-agent") && (
                <span className={styles.issueState}>ready</span>
              )}
            </Command.Item>
          ))}
        </Command.Group>
      ))}
    </>
  );
}
