import Plus from "lucide-react/dist/esm/icons/plus";
import Search from "lucide-react/dist/esm/icons/search";
import Globe from "lucide-react/dist/esm/icons/globe";
import Terminal from "lucide-react/dist/esm/icons/terminal";
import FolderPlus from "lucide-react/dist/esm/icons/folder-plus";
import { useAppStore } from "../../store/app-store";
import { EmptyStateShell, type ActionItem } from "./EmptyStateShell";
import { useIssuesShortcut } from "./useIssuesShortcut";
import type { PaletteView } from "../command-palette/types";

type HomeEmptyStateProps = {
  /** Boots the configured home harness in a fresh tab (⌘N). */
  onNewAgent: () => void;
  /** Opens the directory picker to add a new project. */
  onAddProject: () => void;
  /** Opens the command palette on a specific view (issue lists). */
  onOpenPaletteView?: (view: PaletteView) => void;
};

/** Shown when the home surface has no tabs open. */
export function HomeEmptyState(props: HomeEmptyStateProps) {
  const { onNewAgent, onAddProject, onOpenPaletteView } = props;

  const addBrowserTab = useAppStore((s) => s.addBrowserTab);
  const addTab = useAppStore((s) => s.addTab);

  const { action: issuesAction } = useIssuesShortcut(onOpenPaletteView);

  const actions: ActionItem[] = [
    {
      icon: <FolderPlus size={16} />,
      label: "Add Project",
      keys: [],
      action: onAddProject,
    },
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
      icon: <Globe size={16} />,
      label: "New Browser Window",
      keys: ["⌘", "⇧", "B"],
      action: () => addBrowserTab("about:blank"),
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
    ...(issuesAction ? [issuesAction] : []),
  ];

  return <EmptyStateShell actions={actions} />;
}
