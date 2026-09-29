import { useMemo } from "react";
import { useProjectStore } from "../../../store/project-store";
import { useAppStore } from "../../../store/app-store";
import { useAgentStore } from "../../../store/agent-store";
import { useActiveSnoozes } from "../../../store/snooze-store";
import { runningAgentCount } from "../../../lib/home-dashboard";
import {
  headline,
  needsYouCards,
  openPrStats,
  prPipeline,
} from "../../../lib/home-dashboard-studio";
import type { NewWorkspaceHandler } from "../../../lib/start-issue-work";
import type { PaletteView } from "../../command-palette/types";
import { ActivityTimeline } from "./ActivityTimeline";
import { DashboardHeader } from "./DashboardHeader";
import { HostAlert } from "./HostAlert";
import { NeedsYouCards } from "./NeedsYouCards";
import { PrPipeline } from "./PrPipeline";
import { ProjectTiles } from "./ProjectTiles";
import { StatTiles } from "./StatTiles";
import { UpNextPanel } from "./UpNextPanel";
import { useDashboardAnimate } from "./useDashboardAnimate";
import { useNow } from "./useNow";
import styles from "./HomeDashboard.module.css";

type HomeDashboardProps = {
  /** `data-testid` for the scrolling root, so e2e tests can find Home. */
  testId?: string;
  /** Boots the configured home harness in a fresh tab (⌘N). */
  onNewAgent: () => void;
  /** Opens a plain terminal tab (⌘T). */
  onOpenTerminal: () => void;
  /** Opens the command palette (⌘K). */
  onOpenPalette: () => void;
  /** Opens the New Workspace dialog, prefilled — Up next starts work on an issue with it (ADR-198 T7). */
  onNewWorkspace?: NewWorkspaceHandler;
  /** Opens the palette on a view — Up next's "View all" link (ADR-198 T7). */
  onOpenPaletteView?: (view: PaletteView) => void;
};

/**
 * Home's full dashboard, "Studio" (ADR-198): header, host alert, stat tiles,
 * Needs you cards, then the full-width PR pipeline, the activity timeline,
 * Up next, and project tiles. It reads the same stores the sidebar's
 * indicators do and derives everything with the pure selectors in `home-dashboard-studio.ts`;
 * the section components only render.
 *
 * The root is the Home pane's scroller and query container
 * (`container-name: home`): sections reflow when the *pane* is narrow, which
 * a viewport query can't see because the sidebar takes width.
 */
export function HomeDashboard(props: HomeDashboardProps) {
  const { testId, onNewAgent, onOpenTerminal, onOpenPalette } = props;

  const projects = useProjectStore((s) => s.projects);
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);
  const paneTitle = useAppStore((s) => s.paneTitle);
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
  const running = useMemo(
    () => runningAgentCount(agents, paneAgentStatus),
    [agents, paneAgentStatus],
  );
  const pipeline = useMemo(() => prPipeline(projects, now), [projects, now]);
  const prStats = useMemo(() => openPrStats(pipeline), [pipeline]);
  // The headline's PR clause reads "N PRs are with reviewers": the review
  // stage only, not every open PR.
  const sentence = headline({
    needsYou: cards.length,
    running,
    openPrs: prStats.byStage.review,
  });

  return (
    <div className={styles.pane} data-testid={testId}>
      <div ref={animate} className={styles.page}>
        <DashboardHeader
          now={now}
          headline={sentence}
          urgent={cards.length > 0}
          onNewAgent={onNewAgent}
          onOpenTerminal={onOpenTerminal}
          onOpenPalette={onOpenPalette}
        />
        <HostAlert projects={projects} now={now} />
        <StatTiles
          now={now}
          cards={cards}
          running={running}
          prStats={prStats}
        />
        <NeedsYouCards cards={cards} />

        <PrPipeline pipeline={pipeline} />

        <ActivityTimeline now={now} />

        <UpNextPanel
          onNewWorkspace={props.onNewWorkspace}
          onOpenPaletteView={props.onOpenPaletteView}
        />

        <ProjectTiles now={now} />
      </div>
    </div>
  );
}
