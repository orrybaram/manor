import { useCallback, useMemo, useState, type ReactNode } from "react";
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
  openPrRows,
  runningAgentCount,
  type NeedsYouItem,
  type NeedsYouTier,
} from "../../../lib/home-dashboard";
import type { ProjectInfo, WorkspaceInfo } from "../../../store/project-store";
import type { NewWorkspaceHandler } from "../../../lib/start-issue-work";
import type { PaletteView } from "../../command-palette/types";
import { Button } from "../../ui/Button/Button";
import { PrPopover } from "../PrPopover";
import { useUpNextIssues } from "./useUpNextIssues";
import { useStartUpNextIssue } from "./useStartUpNextIssue";
import shared from "../../EmptyState.module.css";
import styles from "./HomeDashboard.module.css";
import { CountBadge } from "../../ui/CountBadge/CountBadge";

const VISIBLE_COUNT = 4;
const PR_VISIBLE_COUNT = 5;

/** Status-label colour per open-PR readiness; anything unlisted stays dim. */
const PR_STATUS_COLOR: Record<string, string> = {
  blocked: "var(--red)",
  ready: "var(--green)",
};

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
  /** Opens the palette on a view — Up next's "View all" link. */
  onOpenPaletteView?: (view: PaletteView) => void;
};

export function HomeDashboard(props: HomeDashboardProps) {
  const { onNewWorkspace, onOpenPaletteView } = props;
  const projects = useProjectStore((s) => s.projects);
  const selectProject = useProjectStore((s) => s.selectProject);
  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);
  const agents = useAgentStore((s) => s.agents);
  const unseenRespondedAgentIds = useAgentStore((s) => s.unseenRespondedAgentIds);

  const [expanded, setExpanded] = useState(false);
  const [prsExpanded, setPrsExpanded] = useState(false);

  const needsYou = useMemo(
    () => needsYouItems({ projects, agents, paneAgentStatus, unseenRespondedAgentIds }),
    [projects, agents, paneAgentStatus, unseenRespondedAgentIds],
  );
  const runningAgents = useMemo(
    () => runningAgentCount(agents, paneAgentStatus),
    [agents, paneAgentStatus],
  );
  const openPrs = useMemo(() => openPrCount(projects), [projects]);
  const prRows = useMemo(() => openPrRows(projects), [projects]);
  const upNext = useUpNextIssues();
  const handleUpNextClick = useStartUpNextIssue(onNewWorkspace);

  const shownItems = expanded ? needsYou : needsYou.slice(0, VISIBLE_COUNT);
  const moreCount = needsYou.length - VISIBLE_COUNT;
  const shownPrRows = prsExpanded ? prRows : prRows.slice(0, PR_VISIBLE_COUNT);
  const prMoreCount = prRows.length - PR_VISIBLE_COUNT;

  const selectWorkspaceOf = useCallback(
    (project: ProjectInfo, workspace: WorkspaceInfo) => {
      const projectIndex = projects.findIndex((p) => p.id === project.id);
      if (projectIndex < 0) return;
      const workspaceIndex = project.workspaces.findIndex((w) => w.path === workspace.path);
      if (workspaceIndex < 0) return;
      selectProject(projectIndex);
      selectWorkspace(project.id, workspaceIndex);
    },
    [projects, selectProject, selectWorkspace],
  );

  const handleItemClick = useCallback(
    (item: NeedsYouItem) => {
      if (item.kind === "agent") {
        navigateToAgent(item.agent);
        return;
      }
      selectWorkspaceOf(item.project, item.workspace);
    },
    [selectWorkspaceOf],
  );

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
            <CountBadge count={needsYou.length} size="md" className={shared.sectionCount} />
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
                onClick={() => onOpenPaletteView("up-next")}
              >
                View all ({upNext.total})
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
      {prRows.length > 0 && (
        <div className={shared.section}>
          <div className={shared.sectionHeader}>
            Open PRs
            <CountBadge count={prRows.length} size="md" className={shared.sectionCount} />
          </div>
          {shownPrRows.map((row) => (
            // A div, not <Button>: the PR badge is itself a role="button" and
            // buttons can't nest. PrPopover stops click/keydown on its trigger.
            <div
              key={row.pr.url}
              role="button"
              tabIndex={0}
              className={`${shared.action} ${styles.row}`}
              onClick={() => selectWorkspaceOf(row.project, row.workspace)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.target === e.currentTarget) {
                  selectWorkspaceOf(row.project, row.workspace);
                }
              }}
            >
              <PrPopover
                pr={row.pr}
                workspacePath={row.workspace.path}
                hostId={row.project.hostId}
                onOpen={() => window.electronAPI.shell.openExternal(row.pr.url)}
              />
              <span className={`${shared.actionLabel} ${styles.label}`}>{row.pr.title}</span>
              <span className={`${styles.meta} ${styles.prMeta}`}>
                <span
                  className={styles.status}
                  style={{ color: PR_STATUS_COLOR[row.readiness] }}
                >
                  {row.label}
                </span>
                <span
                  className={`${styles.proj} ${styles.prProj}`}
                  style={projectColorStyle(row.project.color)}
                >
                  {row.project.name}
                </span>
              </span>
            </div>
          ))}
          {!prsExpanded && prMoreCount > 0 && (
            <Button variant="ghost" className={styles.more} onClick={() => setPrsExpanded(true)}>
              {prMoreCount} more
            </Button>
          )}
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
