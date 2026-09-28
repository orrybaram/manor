import Plus from "lucide-react/dist/esm/icons/plus";
import Search from "lucide-react/dist/esm/icons/search";
import Terminal from "lucide-react/dist/esm/icons/terminal";
import { useAppStore } from "../../store/app-store";
import { EmptyStateShell, type ActionItem } from "./EmptyStateShell";
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

/** Shown when the home surface has no tabs open. */
export function HomeEmptyState(props: HomeEmptyStateProps) {
  const { onNewAgent, onNewWorkspace, onOpenPaletteView } = props;

  const addTab = useAppStore((s) => s.addTab);

  const actions: ActionItem[] = [
    {
      icon: <Plus size={16} />,
      label: "New Agent",
      keys: ["⌘", "N"],
      action: onNewAgent,
    },
    {
      icon: <Terminal size={16} />,
      label: "Open Terminal",
      keys: ["⌘", "T"],
      action: () => addTab(),
    },
    {
      icon: <Search size={16} />,
      label: "Command Palette",
      keys: ["⌘", "K"],
      action: () => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", metaKey: true }),
        );
      },
    },
  ];

  return (
    <EmptyStateShell actions={actions} testId="home-view">
      <HomeDashboard onNewWorkspace={onNewWorkspace} onOpenPaletteView={onOpenPaletteView} />
    </EmptyStateShell>
  );
}
