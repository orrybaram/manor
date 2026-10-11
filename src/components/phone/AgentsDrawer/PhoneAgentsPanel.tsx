import { useCallback, useMemo, useRef } from "react";
import Plus from "lucide-react/dist/esm/icons/plus";
import Settings from "lucide-react/dist/esm/icons/settings";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import LayoutDashboard from "lucide-react/dist/esm/icons/layout-dashboard";
import ListTodo from "lucide-react/dist/esm/icons/list-todo";
import Search from "lucide-react/dist/esm/icons/search";
import Bell from "lucide-react/dist/esm/icons/bell";
import { refreshState } from "../../../bridge/refresh";
import type { AgentInfo, AgentStatus } from "../../../electron.d";
import { useVisibleAgents } from "../../../hooks/useVisibleAgents";
import { useAgentDisplay } from "../../../hooks/useAgentDisplay";
import { useAgentPulse } from "../../../hooks/useAgentPulse";
import { projectColorStyle } from "../../../hooks/useProjectHeaderRow";
import { useAppStore } from "../../../store/app-store";
import { useNotificationStore } from "../../../store/notification-store";
import { useProjectStore, type ProjectInfo } from "../../../store/project-store";
import { HOME_PATH } from "../../../lib/home";
import { workspaceDisplayName } from "../../../lib/workspace-display-name";
import { agentWorkspaceKey, navigateToAgent } from "../../../utils/agent-navigation";
import { relativeShort } from "../../../utils/relative-time";
import { AgentDot } from "../../ui/AgentDot/AgentDot";
import { Button } from "../../ui/Button/Button";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import { PullIndicator } from "../PullIndicator";
import { usePullToRefresh } from "../usePullToRefresh";
import { buildAgentsDrawerModel } from "./agents-drawer-model";
import styles from "./PhoneAgentsPanel.module.css";

type PhoneAgentsPanelProps = {
  onNewAgent: () => void;
  onOpenSettings: () => void;
  /** Switches the drawer to its projects view. */
  onOpenProjects: () => void;
  onOpenSearch?: () => void;
  onOpenNotifications?: () => void;
  /** Closes the drawer after any navigation. */
  onNavigate: () => void;
};

const NEEDS_YOU_FALLBACK = "Waiting for your input";

/** "5m ago" for an ISO timestamp; empty when it doesn't parse. */
function ago(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "" : relativeShort(ms);
}

/** The agent's workspace name, else the last segment of its path. */
function workspaceLabel(agent: AgentInfo, projects: readonly ProjectInfo[]): string {
  const path = agent.workspacePath ?? agent.cwd;
  const basename = path.split("/").filter(Boolean).pop() ?? "";
  try {
    const key = agentWorkspaceKey(agent, projects);
    return (key && workspaceDisplayName(key, projects)) || basename;
  } catch {
    // `workspaceKey` throws for a remote path it can't encode.
    return basename;
  }
}

/** The trailing label of a grouped row: the live status, else the age. */
function trailingLabel(status: AgentStatus | undefined, agent: AgentInfo): string {
  if (status === "working" || status === "thinking" || status === "error") {
    return status;
  }
  return ago(agent.updatedAt);
}

/**
 * ADR-219 §2: the phone drawer's agents-first content. Agents waiting on the
 * user are pinned at the top as cards, the rest are grouped by project, and
 * the bottom holds the Projects row and an icon nav.
 */
export function PhoneAgentsPanel(props: PhoneAgentsPanelProps) {
  const {
    onNewAgent,
    onOpenSettings,
    onOpenProjects,
    onOpenSearch,
    onOpenNotifications,
    onNavigate,
  } = props;

  const agents = useVisibleAgents();
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);
  const projects = useProjectStore((s) => s.projects);
  const shouldPulse = useAgentPulse();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { pull, refreshing } = usePullToRefresh(scrollRef, refreshState);

  const statusByPane = useMemo(() => {
    const map: Record<string, AgentStatus | undefined> = {};
    for (const [paneId, entry] of Object.entries(paneAgentStatus)) {
      map[paneId] = entry?.status;
    }
    return map;
  }, [paneAgentStatus]);

  const model = useMemo(
    () => buildAgentsDrawerModel({ agents, statusByPane, projects }),
    [agents, statusByPane, projects],
  );

  const projectById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  );

  const totalWorkspaces = useMemo(
    () => projects.reduce((n, p) => n + p.workspaces.length, 0),
    [projects],
  );

  const openAgent = useCallback(
    (agent: AgentInfo) => {
      navigateToAgent(agent);
      onNavigate();
    },
    [onNavigate],
  );

  const handleSelectHome = useCallback(() => {
    useAppStore.getState().setActiveWorkspace(HOME_PATH);
    onNavigate();
  }, [onNavigate]);

  const handleShowTasks = useCallback(() => {
    useAppStore.getState().showTasksView();
    onNavigate();
  }, [onNavigate]);

  return (
    <div className={styles.panel} data-testid="phone-agents-panel">
      <div className={styles.topBar}>
        <Button
          variant="secondary"
          className={styles.newAgent}
          data-testid="drawer-new-agent"
          onClick={onNewAgent}
        >
          <Plus size={15} />
          New agent
        </Button>
        <Tooltip label="Settings">
          <Button
            variant="ghost"
            className={styles.iconButton}
            data-testid="drawer-settings"
            aria-label="Settings"
            onClick={onOpenSettings}
          >
            <Settings size={18} />
          </Button>
        </Tooltip>
      </div>

      <div className={styles.scrollArea}>
      <PullIndicator pull={pull} refreshing={refreshing} />
      <div ref={scrollRef} className={styles.scroll}>
        {agents.length === 0 ? (
          <div className={styles.empty} data-testid="drawer-agents-empty">
            <p className={styles.emptyText}>No agents running</p>
            <Button variant="primary" className={styles.emptyAction} onClick={onNewAgent}>
              <Plus size={15} />
              New agent
            </Button>
          </div>
        ) : (
          <>
            {model.needsYou.length > 0 && (
              <section className={styles.section} aria-label="Needs you">
                <div className={`${styles.sectionLabel} ${styles.needsYouLabel}`}>
                  Needs you · {model.needsYou.length}
                </div>
                <div className={styles.cards}>
                  {model.needsYou.map((agent) => {
                    const project = agent.projectId
                      ? projectById.get(agent.projectId)
                      : undefined;
                    return (
                      <NeedsYouCard
                        key={agent.id}
                        agent={agent}
                        projectName={project?.name ?? agent.projectName ?? ""}
                        projectColor={project?.color ?? null}
                        workspace={workspaceLabel(agent, projects)}
                        pulse={shouldPulse(agent)}
                        onOpen={openAgent}
                      />
                    );
                  })}
                </div>
              </section>
            )}
            {model.needsYou.length > 0 && model.groups.length > 0 && (
              <div className={styles.divider} role="separator" />
            )}
            {model.groups.map((group) => (
              <section
                key={group.projectId}
                className={styles.section}
                aria-label={group.projectName}
              >
                <div className={styles.groupHeader}>
                  <span
                    className={styles.projectSquare}
                    style={projectColorStyle(group.color)}
                  />
                  <span className={styles.groupName}>{group.projectName}</span>
                </div>
                {group.agents.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    pulse={shouldPulse(agent)}
                    onOpen={openAgent}
                  />
                ))}
              </section>
            ))}
          </>
        )}
      </div>
      </div>

      <div className={styles.bottom}>
        <Button
          variant="ghost"
          className={styles.projectsRow}
          data-testid="drawer-projects-row"
          onClick={onOpenProjects}
        >
          <span className={styles.projectsLabel}>Projects</span>
          <span className={styles.projectsCount}>
            {`${projects.length} · ${totalWorkspaces} workspaces`}
          </span>
          <ChevronRight size={16} />
        </Button>
        <nav className={styles.iconNav} aria-label="Main">
          <NavIcon label="Dashboard" testId="home-row" onClick={handleSelectHome}>
            <LayoutDashboard size={18} />
          </NavIcon>
          <NavIcon label="Tasks" testId="tasks-row" onClick={handleShowTasks}>
            <ListTodo size={18} />
          </NavIcon>
          {onOpenSearch && (
            <NavIcon label="Search" testId="search-row" onClick={onOpenSearch}>
              <Search size={18} />
            </NavIcon>
          )}
          {onOpenNotifications && <NotificationsIcon onOpen={onOpenNotifications} />}
        </nav>
      </div>
    </div>
  );
}

type NeedsYouCardProps = {
  agent: AgentInfo;
  projectName: string;
  projectColor: string | null;
  workspace: string;
  pulse: boolean;
  onOpen: (agent: AgentInfo) => void;
};

/** One "Needs you" card: title and age, the agent's ask, and where it runs. */
function NeedsYouCard(props: NeedsYouCardProps) {
  const { agent, projectName, projectColor, workspace, pulse, onOpen } = props;

  const { title, status, reason } = useAgentDisplay(agent);
  // Newest first, so the first match is the latest. Selecting the body alone
  // keeps unrelated notifications from re-rendering the card.
  const message = useNotificationStore(
    (s) =>
      s.notifications.find(
        (n) => n.target?.type === "agent" && n.target.agentId === agent.id,
      )?.body,
  );

  return (
    <Button
      variant="ghost"
      className={styles.card}
      data-testid="drawer-agent-row"
      data-agent-id={agent.id}
      data-needs-you=""
      onClick={() => onOpen(agent)}
    >
      <span className={styles.cardLine}>
        <span className={styles.dotCell}>
          <AgentDot status={status} size="sidebar" pulse={pulse} reason={reason} />
        </span>
        <span className={styles.cardTitle}>{title}</span>
        <span className={styles.time}>{ago(agent.updatedAt)}</span>
      </span>
      <span className={styles.cardMessage}>{message || NEEDS_YOU_FALLBACK}</span>
      <span className={styles.cardWhere}>
        <span className={styles.projectSquare} style={projectColorStyle(projectColor)} />
        <span className={styles.cardWhereText}>
          {projectName} / {workspace}
        </span>
      </span>
    </Button>
  );
}

type AgentRowProps = {
  agent: AgentInfo;
  pulse: boolean;
  onOpen: (agent: AgentInfo) => void;
};

/** One agent in a project group: dot, title and a trailing status or age. */
function AgentRow(props: AgentRowProps) {
  const { agent, pulse, onOpen } = props;

  const { title, status, reason } = useAgentDisplay(agent);
  const trailing = trailingLabel(status, agent);

  return (
    <Button
      variant="ghost"
      className={styles.row}
      data-testid="drawer-agent-row"
      data-agent-id={agent.id}
      onClick={() => onOpen(agent)}
    >
      <span className={styles.dotCell}>
        {status && status !== "idle" ? (
          <AgentDot status={status} size="sidebar" pulse={pulse} reason={reason} />
        ) : (
          <span className={styles.idleDot} />
        )}
      </span>
      <span className={styles.rowTitle}>{title}</span>
      <span
        className={`${styles.time} ${status === "error" ? styles.errorLabel : ""}`}
      >
        {trailing}
      </span>
    </Button>
  );
}

type NavIconProps = {
  label: string;
  testId: string;
  onClick: () => void;
  children: React.ReactNode;
};

function NavIcon(props: NavIconProps) {
  const { label, testId, onClick, children } = props;

  return (
    <Tooltip label={label} side="top">
      <Button
        variant="ghost"
        className={styles.navButton}
        data-testid={testId}
        aria-label={label}
        onClick={onClick}
      >
        {children}
      </Button>
    </Tooltip>
  );
}

type NotificationsIconProps = {
  onOpen: () => void;
};

/** The nav's bell, with a dot while anything is unread. */
function NotificationsIcon(props: NotificationsIconProps) {
  const { onOpen } = props;

  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const label =
    unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications";

  return (
    <Tooltip label="Notifications" side="top">
      <Button
        variant="ghost"
        className={styles.navButton}
        data-testid="notifications-row"
        aria-label={label}
        onClick={onOpen}
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <span className={styles.unreadDot} data-testid="notifications-row-badge" />
        )}
      </Button>
    </Tooltip>
  );
}
