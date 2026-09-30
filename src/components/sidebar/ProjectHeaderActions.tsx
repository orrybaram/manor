import type React from "react";
import FolderPlus from "lucide-react/dist/esm/icons/folder-plus";
import Plus from "lucide-react/dist/esm/icons/plus";
import Settings from "lucide-react/dist/esm/icons/settings";
import { Button } from "../ui/Button/Button";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import styles from "./ProjectItem.module.css";

type ProjectHeaderActionsProps = {
  onNewWorkspace: () => void;
  onNewFolder: () => void;
  onOpenSettings?: () => void;
};

/** Icon buttons revealed when the project header is hovered. */
export function ProjectHeaderActions(props: ProjectHeaderActionsProps) {
  const { onNewWorkspace, onNewFolder, onOpenSettings } = props;
  // The header toggles on click, drags on pointer-down and handles arrow keys;
  // none of that should fire from its buttons.
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const actions = [
    { label: "New Workspace", Icon: Plus, onClick: onNewWorkspace },
    { label: "New Folder", Icon: FolderPlus, onClick: onNewFolder },
    ...(onOpenSettings
      ? [{ label: "Project Settings", Icon: Settings, onClick: onOpenSettings }]
      : []),
  ];

  return (
    <span
      className={styles.projectActions}
      onClick={stop}
      onPointerDown={stop}
      onKeyDown={stop}
      onContextMenu={stop}
    >
      {actions.map(({ label, Icon, onClick }) => (
        <Tooltip key={label} label={label}>
          <Button
            variant="ghost"
            className={styles.projectAction}
            aria-label={label}
            onClick={onClick}
          >
            <Icon size={13} />
          </Button>
        </Tooltip>
      ))}
    </span>
  );
}
