import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Bot from "lucide-react/dist/esm/icons/bot";
import GitPullRequest from "lucide-react/dist/esm/icons/git-pull-request";
import Check from "lucide-react/dist/esm/icons/check";
import CircleDot from "lucide-react/dist/esm/icons/circle-dot";
import { useProjectStore } from "../../../store/project-store";
import { useAppStore } from "../../../store/app-store";
import { useAgentStore } from "../../../store/agent-store";
import { navigateToAgent } from "../../../utils/agent-navigation";
import { projectColorStyle } from "../../../hooks/useProjectHeaderRow";
import {
  needsYouItems,
  openPrCount,
  runningAgentCount,
  type NeedsYouItem,
  type NeedsYouTier,
} from "../../../lib/home-dashboard";
import { ghRepoOf } from "../../../lib/gh-repo";
import {
  startGitHubIssueWork,
  startLinearIssueWork,
  type NewWorkspaceHandler,
} from "../../../lib/start-issue-work";
import type { GitHubIssue, LinearIssue } from "../../../electron.d";
import type { PaletteView } from "../../command-palette/types";
import { Button } from "../../ui/Button/Button";
import { useUpNextIssues, type UpNextRow } from "./useUpNextIssues";
import shared from "../../EmptyState.module.css";
import styles from "./HomeDashboard.module.css";

const VISIBLE_COUNT = 4;

/** Icon colour per Needs-you tier (ADR-194 §1: red / yellow / green / cyan). */
const TIER_COLOR: Record<NeedsYouTier, string> = {
  input: "var(--red)",
  error: "var(--red)",
  blocked: "var(--yellow)",
  ready: "var(--green)",
  finished: "var(--cyan)",
};

const AGENT_TIER_LABEL: Record<"input" | "error" | "finished", string> = {
  input: "Agent wants input",
  error: "Agent errored",
  finished: "Agent finished",
};

function itemKey(item: NeedsYouItem): string {
  return item.kind === "agent" ? `agent:${item.agent.id}` : `pr:${item.pr.url}`;
}

/** "4m" / "3h" / "2d" — the age of an agent's last status update. */
function formatAge(updatedAt: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(updatedAt)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * A Needs-you row's label: "Agent wants input · <workspace>", "Agent
 * errored", "#N checks failing", "#N ready to merge" (ADR-194 §1).
 */
function itemLabel(item: NeedsYouItem): { text: string; sub?: string } {
  if (item.kind === "pr") {
    return { text: `#${item.pr.number} ${item.reason}` };
  }
  const sub = item.workspace?.name ?? item.workspace?.path ?? undefined;
  return { text: AGENT_TIER_LABEL[item.tier], sub };
}

/**
 * Home's "Needs you" section and summary line (ADR-194 §1). Reads the same
 * stores the sidebar's own indicators do and ranks with the pure selectors
 * from `home-dashboard.ts` — this component only wires state in and renders.
 * "Up next" sits between the Needs-you section and the summary line.
 */
type HomeDashboardProps = {
  /** Opens the New Workspace dialog, prefilled — starts work on an Up next issue. */
  onNewWorkspace?: NewWorkspaceHandler;
  /** Opens the palette on a view — Up next's "All issues" link. */
  onOpenPaletteView?: (view: PaletteView) => void;
};

export function HomeDashboard(props: HomeDashboardProps) {
  const { onNewWorkspace, onOpenPaletteView } = props;
  const projects = useProjectStore((s) => s.projects);
  const selectProject = useProjectStore((s) => s.selectProject);
  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);
  const selectedProjectIndex = useProjectStore((s) => s.selectedProjectIndex);
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);
  const agents = useAgentStore((s) => s.agents);
  const unseenRespondedAgentIds = useAgentStore((s) => s.unseenRespondedAgentIds);

  const [expanded, setExpanded] = useState(false);

  const needsYou = useMemo(
    () => needsYouItems({ projects, agents, paneAgentStatus, unseenRespondedAgentIds }),
    [projects, agents, paneAgentStatus, unseenRespondedAgentIds],
  );
  const runningAgents = useMemo(
    () => runningAgentCount(agents, paneAgentStatus),
    [agents, paneAgentStatus],
  );
  const openPrs = useMemo(() => openPrCount(projects), [projects]);
  const upNext = useUpNextIssues();
  const queryClient = useQueryClient();

  const shownItems = expanded ? needsYou : needsYou.slice(0, VISIBLE_COUNT);
  const moreCount = needsYou.length - VISIBLE_COUNT;

  const handleItemClick = useCallback(
    (item: NeedsYouItem) => {
      if (item.kind === "agent") {
        navigateToAgent(item.agent);
        return;
      }
      const projectIndex = projects.findIndex((p) => p.id === item.project.id);
      if (projectIndex < 0) return;
      const workspaceIndex = item.project.workspaces.findIndex(
        (w) => w.path === item.workspace.path,
      );
      if (workspaceIndex < 0) return;
      selectProject(projectIndex);
      selectWorkspace(item.project.id, workspaceIndex);
    },
    [projects, selectProject, selectWorkspace],
  );

  // A click fetches the issue body first; ignore repeat clicks meanwhile.
  const startingRef = useRef(false);
  const handleUpNextClick = useCallback(
    async (row: UpNextRow) => {
      if (startingRef.current) return;
      startingRef.current = true;
      try {
        const { issue, project } = row;
        if (issue.source === "github") {
          const listed = issue.raw as GitHubIssue;
          const repo = ghRepoOf(project);
          // `getMyIssues` has no body; the palette's detail query does. Same key,
          // so a palette visit and a Home click share the cache. Title only if
          // the detail fetch fails.
          const detail = await queryClient
            .fetchQuery({
              queryKey: ["github-issue-detail", repo.hostId, repo.path, listed.number, listed.url],
              queryFn: () =>
                window.electronAPI.github.getIssueDetail(repo, listed.number, listed.url),
              staleTime: 60_000,
              retry: false,
            })
            .catch(() => null);
          startGitHubIssueWork({
            project,
            repo,
            issue: { ...listed, body: detail?.body ?? null },
            onNewWorkspace,
          });
        } else {
          const listed = issue.raw as LinearIssue;
          const detail = await queryClient
            .fetchQuery({
              queryKey: ["linear-issue-detail", listed.id],
              queryFn: () => window.electronAPI.linear.getIssueDetail(listed.id),
              staleTime: 60_000,
              retry: false,
            })
            .catch(() => null);
          startLinearIssueWork({
            project,
            issue: { ...listed, description: detail?.description ?? null },
            onNewWorkspace,
          });
        }
      } finally {
        startingRef.current = false;
      }
    },
    [queryClient, onNewWorkspace],
  );

  const selectedProject = projects[selectedProjectIndex];
  const allIssuesView: PaletteView =
    (selectedProject?.linearAssociations.length ?? 0) > 0 ? "linear-all" : "github-all";

  const issuesReady = upNext.total;
  const summaryParts: ReactNode[] = [];
  if (runningAgents > 0) {
    summaryParts.push(
      <span key="agents">
        <b>{runningAgents}</b> agent{runningAgents === 1 ? "" : "s"} running
      </span>,
    );
  }
  if (openPrs > 0) {
    summaryParts.push(
      <span key="prs">
        <b>{openPrs}</b> open PR{openPrs === 1 ? "" : "s"}
      </span>,
    );
  }
  if (issuesReady > 0) {
    summaryParts.push(
      <span key="issues">
        <b>{issuesReady}</b> issue{issuesReady === 1 ? "" : "s"} ready
      </span>,
    );
  }

  return (
    <div className={styles.root}>
      {needsYou.length > 0 && (
        <div className={shared.section}>
          <div className={shared.sectionHeader}>
            Needs you
            <span className={shared.sectionCount}>{needsYou.length}</span>
          </div>
          {shownItems.map((item) => {
            const { text, sub } = itemLabel(item);
            const age = item.kind === "agent" ? formatAge(item.agent.updatedAt) : null;
            return (
              <Button
                key={itemKey(item)}
                variant="ghost"
                className={`${shared.action} ${styles.row}`}
                onClick={() => handleItemClick(item)}
              >
                <span className={shared.actionIcon} style={{ color: TIER_COLOR[item.tier] }}>
                  {item.kind === "agent" ? <Bot size={16} /> : <GitPullRequest size={16} />}
                </span>
                <span className={`${shared.actionLabel} ${styles.label}`}>
                  {text}
                  {sub && <span className={styles.labelDim}> · {sub}</span>}
                </span>
                <span className={styles.meta}>
                  <span className={styles.proj} style={projectColorStyle(item.project.color)}>
                    {item.project.name}
                  </span>
                  {age !== null && <span className={styles.age}>{age}</span>}
                  <span className={styles.hoverHint}>
                    {item.kind === "agent" ? "Focus" : "Open"} ↵
                  </span>
                </span>
              </Button>
            );
          })}
          {!expanded && moreCount > 0 && (
            <Button
              variant="ghost"
              className={styles.more}
              onClick={() => setExpanded(true)}
            >
              {moreCount} more
            </Button>
          )}
        </div>
      )}
      {upNext.top.length > 0 && (
        <div className={shared.section}>
          <div className={shared.sectionHeader}>
            Up next
            {onOpenPaletteView && (
              <Button
                variant="link"
                className={`${shared.sectionLink} ${styles.sectionLink}`}
                onClick={() => onOpenPaletteView(allIssuesView)}
              >
                All issues
              </Button>
            )}
          </div>
          {upNext.top.map((row) => (
            <Button
              key={`${row.issue.source}:${row.issue.url}`}
              variant="ghost"
              className={`${shared.action} ${styles.row}`}
              onClick={() => void handleUpNextClick(row)}
            >
              <span className={shared.actionIcon} style={{ color: "var(--accent)" }}>
                <CircleDot size={16} />
              </span>
              <span className={`${shared.actionLabel} ${styles.label}`}>
                <span className={styles.labelDim}>{row.issue.identifier}</span> {row.issue.title}
              </span>
              <span className={styles.meta}>
                <span className={styles.proj} style={projectColorStyle(row.color)}>
                  {row.entryName}
                </span>
                <span className={styles.hoverHint}>Start agent ↵</span>
              </span>
            </Button>
          ))}
        </div>
      )}
      {needsYou.length === 0 && upNext.top.length === 0 && !upNext.loading && (
        <div className={styles.clearline}>
          <span className={shared.actionIcon} style={{ color: "var(--green)" }}>
            <Check size={16} />
          </span>
          Nothing needs you
        </div>
      )}
      {summaryParts.length > 0 && (
        <div className={styles.summary}>
          {summaryParts.flatMap((part, i) =>
            i === 0 ? [part] : [<span key={`sep-${i}`}>·</span>, part],
          )}
        </div>
      )}
    </div>
  );
}
