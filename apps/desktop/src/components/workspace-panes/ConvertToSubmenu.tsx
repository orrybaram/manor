import * as ContextMenu from "@radix-ui/react-context-menu";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import SquareTerminal from "lucide-react/dist/esm/icons/square-terminal";
import Globe from "lucide-react/dist/esm/icons/globe";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import Bot from "lucide-react/dist/esm/icons/bot";
import { usePaneContentType } from "../../store/app-store";
import { convertPaneTo } from "../../lib/pane-actions";
import styles from "./PaneLayout/PaneLayout.module.css";

const PANE_TYPES = [
  { type: "terminal" as const, label: "Terminal", icon: SquareTerminal },
  { type: "browser" as const, label: "Browser", icon: Globe },
  { type: "scm" as const, label: "Source Control", icon: GitBranch },
  { type: "agent" as const, label: "Agent", icon: Bot },
];

export function ConvertToSubmenu({ paneId }: { paneId: string }) {
  const currentType = usePaneContentType(paneId);

  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className={styles.contextMenuItem}>
        Convert to
        <ChevronRight size={14} style={{ marginLeft: "auto" }} />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent className={styles.contextMenu}>
          {PANE_TYPES.filter((p) => p.type !== currentType).map(({ type, label, icon: Icon }) => (
            <ContextMenu.Item
              key={type}
              className={styles.contextMenuItem}
              // A file pane's unsaved edits ask first (`convertPaneTo`).
              onSelect={() => convertPaneTo(paneId, type)}
            >
              <Icon size={14} />
              {label}
            </ContextMenu.Item>
          ))}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}
