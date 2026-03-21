import { FolderDown } from "lucide-react";
import { useProjectStore } from "../store/project-store";
import { EmptyStateShell, type ActionItem } from "./EmptyStateShell";

/** Shown when there are no projects at all. */
export function WelcomeEmptyState() {
  const addProjectFromDirectory = useProjectStore(
    (s) => s.addProjectFromDirectory,
  );

  const actions: ActionItem[] = [
    {
      icon: <FolderDown size={16} />,
      label: "Import Project",
      keys: [],
      action: addProjectFromDirectory,
    },
  ];

  return (
    <EmptyStateShell
      subtitle="Open a project to get started"
      actions={actions}
    />
  );
}
