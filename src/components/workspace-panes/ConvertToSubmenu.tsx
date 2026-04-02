import * as ContextMenu from "@radix-ui/react-context-menu";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import SquareTerminal from "lucide-react/dist/esm/icons/square-terminal";
import Globe from "lucide-react/dist/esm/icons/globe";
import GitCompareArrows from "lucide-react/dist/esm/icons/git-compare-arrows";
import Bot from "lucide-react/dist/esm/icons/bot";
import { useAppStore } from "../../store/app-store";
import { getAgentCommand } from "../../agent-defaults";
import styles from "./PaneLayout/PaneLayout.module.css";

const PANE_TYPES = [
  { type: "terminal" as const, label: "Terminal", icon: SquareTerminal },
  { type: "browser" as const, label: "Browser", icon: Globe },
  { type: "diff" as const, label: "Diff", icon: GitCompareArrows },
  { type: "task" as const, label: "Task", icon: Bot },
];

export function ConvertToSubmenu({ paneId }: { paneId: string }) {
  const currentType = useAppStore((s) => s.paneContentType[paneId] ?? "terminal");
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
                if (type === "task") {
                  const command = getAgentCommand(useAppStore.getState().activeWorkspacePath);
                  if (currentType === "terminal") {
                    // Terminal already mounted — write directly
                    window.electronAPI.pty.write(paneId, command + "\n");
                  } else {
                    // Switching from browser/diff — terminal will mount fresh
                    setPaneContentType(paneId, "terminal");
                    useAppStore.setState((state) => ({
                      pendingPaneCommands: { ...state.pendingPaneCommands, [paneId]: command },
                    }));
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
