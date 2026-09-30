import { HomeDashboard } from "./HomeDashboard/HomeDashboard";
import type { NewWorkspaceHandler } from "../../lib/start-issue-work";

type HomeEmptyStateProps = {
  /** Opens the New Workspace dialog — Up next starts work on an issue with it. */
  onNewWorkspace?: NewWorkspaceHandler;
};

/**
 * The Dashboard surface (internally "home"): the full-width Studio dashboard
 * (ADR-198). No launchers — the Dashboard never holds tabs (ADR-197).
 */
export function HomeEmptyState(props: HomeEmptyStateProps) {
  const { onNewWorkspace } = props;

  return (
    <HomeDashboard
      testId="home-view"
      onNewWorkspace={onNewWorkspace}
    />
  );
}
