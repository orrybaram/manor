import { useCallback, useMemo } from "react";
import Plus from "lucide-react/dist/esm/icons/plus";
import Settings from "lucide-react/dist/esm/icons/settings";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import LayoutDashboard from "lucide-react/dist/esm/icons/layout-dashboard";
import ListTodo from "lucide-react/dist/esm/icons/list-todo";
import Search from "lucide-react/dist/esm/icons/search";
import Bell from "lucide-react/dist/esm/icons/bell";
import { refreshState } from "../../../bridge/resync";
import type { AgentInfo } from "../../../electron.d";
import { useVisibleAgents } from "../../../hooks/useVisibleAgents";
import { useAgentDisplay } from "../../../hooks/useAgentDisplay";
import { useAgentPulse } from "../../../hooks/useAgentPulse";
import { projectColorStyle } from "../../../hooks/useProjectHeaderRow";
import { useSidebarNav } from "../../../hooks/useSidebarNav";
import { useAppStore } from "../../../store/app-store";
import { useNotificationStore } from "../../../store/notification-store";
import { useProjectStore } from "../../../store/project-store";
import { navigateToAgent } from "../../../utils/agent-navigation";
import { relativeShortIso } from "../../../utils/relative-time";
import { useUnreadNotificationCount } from "../../../hooks/useUnreadNotificationCount";
import { UnreadBadge } from "../../notifications/UnreadBadge";
import { AgentDot } from "../../ui/AgentDot/AgentDot";
import { Button } from "../../ui/Button/Button";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import { PullToRefresh } from "../PullToRefresh";
import {
  buildAgentsDrawerModel,
  type AgentsDrawerNeedsYou,
  type AgentsDrawerRow,
} from "./agents-drawer-model";
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

  const model = useMemo(
    () => buildAgentsDrawerModel({ agents, paneAgentStatus, projects }),
    [agents, paneAgentStatus, projects],
  );

  const openAgent = useCallback(
    (agent: AgentInfo) => {
      navigateToAgent(agent);
      onNavigate();
    },
    [onNavigate],
  );

  const { selectHome, showTasks } = useSidebarNav(onNavigate);

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
      <PullToRefresh onRefresh={refreshState} className={styles.scroll}>
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
                  {model.needsYou.map((item) => (
                    <NeedsYouCard
                      key={item.agent.id}
                      item={item}
                      pulse={shouldPulse(item.agent)}
                      onOpen={openAgent}
                    />
                  ))}
                </div>
              </section>
            )}
            {model.needsYou.length > 0 && model.groups.length > 0 && (
              <div className={styles.divider} role="separator" />
            )}
            {model.groups.map((group) => (
              <section
                key={group.key}
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
                {group.rows.map((row) => (
                  <AgentRow
                    key={row.agent.id}
                    row={row}
                    pulse={shouldPulse(row.agent)}
                    onOpen={openAgent}
                  />
                ))}
              </section>
            ))}
          </>
        )}
      </PullToRefresh>
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
            {model.projectsSummary}
          </span>
          <ChevronRight size={16} />
        </Button>
        <nav className={styles.iconNav} aria-label="Main">
          <NavIcon label="Dashboard" testId="home-row" onClick={selectHome}>
            <LayoutDashboard size={18} />
          </NavIcon>
          <NavIcon label="Tasks" testId="tasks-row" onClick={showTasks}>
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
  item: AgentsDrawerNeedsYou;
  pulse: boolean;
  onOpen: (agent: AgentInfo) => void;
};

/** One "Needs you" card: title and age, the agent's ask, and where it runs. */
function NeedsYouCard(props: NeedsYouCardProps) {
  const { item, pulse, onOpen } = props;
  const { agent, projectName, color, workspaceLabel } = item;

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
        <span className={styles.time}>{relativeShortIso(agent.updatedAt)}</span>
      </span>
      <span className={styles.cardMessage}>{message || NEEDS_YOU_FALLBACK}</span>
      <span className={styles.cardWhere}>
        <span className={styles.projectSquare} style={projectColorStyle(color)} />
        <span className={styles.cardWhereText}>
          {projectName} / {workspaceLabel}
        </span>
      </span>
    </Button>
  );
}

type AgentRowProps = {
  row: AgentsDrawerRow;
  pulse: boolean;
  onOpen: (agent: AgentInfo) => void;
};

/** One agent in a project group: dot, title and a trailing status or age. */
function AgentRow(props: AgentRowProps) {
  const { row, pulse, onOpen } = props;
  const { agent, trailing, error } = row;

  const { title, status, reason } = useAgentDisplay(agent);

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
        className={`${styles.time} ${error ? styles.errorLabel : ""}`}
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

  const unreadCount = useUnreadNotificationCount();
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
        <UnreadBadge variant="dot" className={styles.unreadDot} />
      </Button>
    </Tooltip>
  );
}
