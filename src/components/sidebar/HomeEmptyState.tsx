import { EmptyStateShell } from "./EmptyStateShell";
import { HomeDashboard } from "./HomeDashboard/HomeDashboard";
import type { NewWorkspaceHandler } from "../../lib/start-issue-work";
import type { PaletteView } from "../command-palette/types";

type HomeEmptyStateProps = {
  /** Opens the New Workspace dialog — Up next starts work on an issue with it. */
  onNewWorkspace?: NewWorkspaceHandler;
  /** Opens the palette on a view — Up next's "All issues" link. */
  onOpenPaletteView?: (view: PaletteView) => void;
};

/** The Dashboard surface (internally "home"): the dashboard, no launchers. */
export function HomeEmptyState(props: HomeEmptyStateProps) {
  const { onNewWorkspace, onOpenPaletteView } = props;

  return (
    <EmptyStateShell testId="home-view">
      <HomeDashboard onNewWorkspace={onNewWorkspace} onOpenPaletteView={onOpenPaletteView} />
    </EmptyStateShell>
  );
}
