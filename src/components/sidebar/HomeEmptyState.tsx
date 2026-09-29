import { HomeDashboard } from "./HomeDashboard/HomeDashboard";
import type { NewWorkspaceHandler } from "../../lib/start-issue-work";
import type { PaletteView } from "../command-palette/types";

type HomeEmptyStateProps = {
  /** Opens the New Workspace dialog — Up next starts work on an issue with it. */
  onNewWorkspace?: NewWorkspaceHandler;
  /** Opens the palette on a view — Up next's "All issues" link. */
  onOpenPaletteView?: (view: PaletteView) => void;
};

/**
 * The Dashboard surface (internally "home"): the full-width Studio dashboard
 * (ADR-198). No launchers — the Dashboard never holds tabs (ADR-197).
 */
export function HomeEmptyState(props: HomeEmptyStateProps) {
  const { onNewWorkspace, onOpenPaletteView } = props;

  return (
    <HomeDashboard
      testId="home-view"
      onOpenPalette={() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
      }}
      onNewWorkspace={onNewWorkspace}
      onOpenPaletteView={onOpenPaletteView}
    />
  );
}
