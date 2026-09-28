import Plus from "lucide-react/dist/esm/icons/plus";
import Search from "lucide-react/dist/esm/icons/search";
import Terminal from "lucide-react/dist/esm/icons/terminal";
import { useAppStore } from "../../store/app-store";
import { EmptyStateShell, type ActionItem } from "./EmptyStateShell";
import { HomeDashboard } from "./HomeDashboard/HomeDashboard";

type HomeEmptyStateProps = {
  /** Boots the configured home harness in a fresh tab (⌘N). */
  onNewAgent: () => void;
};

/** Shown when the home surface has no tabs open. */
export function HomeEmptyState(props: HomeEmptyStateProps) {
  const { onNewAgent } = props;

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
      <HomeDashboard />
    </EmptyStateShell>
  );
}
