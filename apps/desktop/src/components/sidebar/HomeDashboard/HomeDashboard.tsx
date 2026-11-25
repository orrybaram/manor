import { useMemo } from "react";
import { useProjectStore } from "../../../store/project-store";
import { useAppStore } from "../../../store/app-store";
import { useAgentStore } from "../../../store/agent-store";
import { useActiveSnoozes } from "../../../store/snooze-store";
import { useCleanPaneTitles } from "../../../hooks/useAgentDisplay";
import {
  needsYouCards,
  openPrStats,
  prTable,
} from "../../../lib/home-dashboard-studio";
import type { NewWorkspaceHandler } from "../../../lib/start-issue-work";
import { DashboardRail } from "./DashboardRail";
import { HostAlert } from "./HostAlert";
import { NeedsYouList } from "./NeedsYouList";
import { PrTable } from "./PrTable";
import { useDashboardAnimate } from "./useDashboardAnimate";
import { useNow } from "./useNow";
import styles from "./HomeDashboard.module.css";

type HomeDashboardProps = {
  /** `data-testid` for the scrolling root, so e2e tests can find Home. */
  testId?: string;
  /** Opens the New Workspace dialog, prefilled — Up next starts work on an issue with it. */
  onNewWorkspace?: NewWorkspaceHandler;
};

/**
 * Home's full dashboard, "Studio": the host alert, Needs you and the PR
 * table in the main column, and a quieter rail of stats (Agents working,
 * Open PRs, Merged this week, Up next) beside it on a wide pane or under it
 * on a narrow one. It reads the same stores the sidebar's indicators do and
 * derives everything with the pure selectors in `home-dashboard-studio.ts`;
 * the section components only render.
 *
 * The root is the Home pane's scroller and query container
 * (`container-name: home`): sections reflow when the *pane* is narrow, which
 * a viewport query can't see because the sidebar takes width.
 */
export function HomeDashboard(props: HomeDashboardProps) {
  const { testId, onNewWorkspace } = props;

  const projects = useProjectStore((s) => s.projects);
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);
  // Cleaned titles: an agent's spinner frames don't re-render the dashboard.
  const paneTitle = useCleanPaneTitles();
  const agents = useAgentStore((s) => s.agents);
  const unseenRespondedAgentIds = useAgentStore(
    (s) => s.unseenRespondedAgentIds,
  );
  const snoozed = useActiveSnoozes();
  const now = useNow();
  const animate = useDashboardAnimate();

  const cards = useMemo(
    () =>
      needsYouCards(
        {
          projects,
          agents,
          paneAgentStatus,
          unseenRespondedAgentIds,
          paneTitle,
          snoozed,
        },
        now,
      ),
    [
      projects,
      agents,
      paneAgentStatus,
      unseenRespondedAgentIds,
      paneTitle,
      snoozed,
      now,
    ],
  );
  const prRows = useMemo(() => prTable(projects, now), [projects, now]);
  const prStats = useMemo(() => openPrStats(prRows), [prRows]);

  return (
    <div className={styles.pane} data-testid={testId}>
      <div className={styles.page}>
        <div ref={animate} className={styles.main}>
          <HostAlert projects={projects} now={now} />
          <NeedsYouList cards={cards} />
          <PrTable rows={prRows} />
        </div>
        <DashboardRail
          className={styles.rail}
          now={now}
          prStats={prStats}
          onNewWorkspace={onNewWorkspace}
        />
      </div>
    </div>
  );
}
