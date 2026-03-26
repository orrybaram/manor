import { FolderDown } from "lucide-react";
import { EmptyStateShell, type ActionItem } from "./EmptyStateShell";

interface WelcomeEmptyStateProps {
  onAddProject: () => void;
}

/** Shown when there are no projects at all. */
export function WelcomeEmptyState({ onAddProject }: WelcomeEmptyStateProps) {
  const actions: ActionItem[] = [
    {
      icon: <FolderDown size={16} />,
      label: "Import Project",
      keys: [],
      action: onAddProject,
    },
  ];

  return (
    <EmptyStateShell
      subtitle="Open a project to get started"
      actions={actions}
    />
  );
}
