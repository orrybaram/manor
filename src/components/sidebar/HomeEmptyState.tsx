import { useAppStore } from "../../store/app-store";
import { HomeDashboard } from "./HomeDashboard/HomeDashboard";
import type { NewWorkspaceHandler } from "../../lib/start-issue-work";
import type { PaletteView } from "../command-palette/types";

type HomeEmptyStateProps = {
  /** Boots the configured home harness in a fresh tab (⌘N). */
  onNewAgent: () => void;
  /** Opens the New Workspace dialog — Up next starts work on an issue with it. */
  onNewWorkspace?: NewWorkspaceHandler;
  /** Opens the palette on a view — Up next's "All issues" link. */
  onOpenPaletteView?: (view: PaletteView) => void;
};

/**
 * Shown when the home surface has no tabs open: the full-width Studio
 * dashboard (ADR-198), not `EmptyStateShell`'s 480px launcher column. The
 * launcher's ⌘N / ⌘T / ⌘K rows became the dashboard header's buttons.
 */
export function HomeEmptyState(props: HomeEmptyStateProps) {
  const { onNewAgent, onNewWorkspace, onOpenPaletteView } = props;

  const addTab = useAppStore((s) => s.addTab);

  return (
    <HomeDashboard
      testId="home-view"
      onNewAgent={onNewAgent}
      onOpenTerminal={() => addTab()}
      onOpenPalette={() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
      }}
      onNewWorkspace={onNewWorkspace}
      onOpenPaletteView={onOpenPaletteView}
    />
  );
}
