import * as ContextMenu from "@radix-ui/react-context-menu";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import SquareTerminal from "lucide-react/dist/esm/icons/square-terminal";
import Globe from "lucide-react/dist/esm/icons/globe";
import GitCompareArrows from "lucide-react/dist/esm/icons/git-compare-arrows";
import Bot from "lucide-react/dist/esm/icons/bot";
import {
  sendPendingCommand,
  useAppStore,
  usePaneContentType,
} from "../../store/app-store";
import { getAgentCommand } from "../../agent-defaults";
import styles from "./PaneLayout/PaneLayout.module.css";

const PANE_TYPES = [
  { type: "terminal" as const, label: "Terminal", icon: SquareTerminal },
  { type: "browser" as const, label: "Browser", icon: Globe },
  { type: "diff" as const, label: "Diff", icon: GitCompareArrows },
  { type: "agent" as const, label: "Agent", icon: Bot },
];

export function ConvertToSubmenu({ paneId }: { paneId: string }) {
  const currentType = usePaneContentType(paneId);
  const setPaneContentType = useAppStore((s) => s.setPaneContentType);

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
              onSelect={() => {
                if (type === "agent") {
                  const command = getAgentCommand(useAppStore.getState().activeWorkspacePath);
                  if (currentType === "terminal") {
                    // Terminal already mounted — write directly
                    window.electronAPI.pty.write(paneId, command + "\n");
                  } else {
                    // Switching from browser/diff — the terminal mounts
                    // fresh, and the server types the command into it once
                    // its shell is ready (ADR-179 ticket 11).
                    sendPendingCommand(paneId, command, "agent-startup");
                    setPaneContentType(paneId, "terminal");
                  }
                } else {
                  setPaneContentType(paneId, type);
                }
              }}
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
