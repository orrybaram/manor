import PanelLeft from "lucide-react/dist/esm/icons/panel-left";
import Search from "lucide-react/dist/esm/icons/search";
import { Button } from "../ui/Button/Button";
import { isWebApp } from "../../lib/platform";
import { workspaceDisplayName } from "../../lib/workspace-display-name";
import { selectActiveWorkspaceKey, useAppStore } from "../../store/app-store";
import { useProjectStore } from "../../store/project-store";
import styles from "./Phone.module.css";

/**
 * `hiddenInset` + `trafficLightPosition` (`electron/window.ts`) are macOS-only
 * — Electron ignores them elsewhere, so a narrow Electron window on another
 * platform still has its own native title bar to drag by, and a browser tab
 * has no window chrome at all. Only this combination needs the top bar to
 * clear the traffic lights and stand in as a drag region.
 */
function isElectronMacOS(): boolean {
  return (
    !isWebApp() &&
    typeof navigator !== "undefined" &&
    (navigator.platform?.includes("Mac") ||
      navigator.userAgent?.includes("Mac"))
  );
}

type PhoneTopBarProps = {
  /** Opens/closes the sidebar drawer. */
  onToggleDrawer: () => void;
  /** Opens the command palette — the same `CommandPalette` the desk layout
   *  has, full screen at phone width. */
  onOpenPalette: () => void;
};

/**
 * ADR-181 D3: the phone shell's top bar — a drawer toggle, the active
 * workspace's name, and the command palette, which a phone reaches
 * everything else through (another pane is its Next Pane / Focus Next Panel). Rendered once, by
 * `PhoneChrome`, around the workspace stack — never inside a split
 * component, so it cannot affect a terminal's geometry, and switching panes
 * remounts nothing here either.
 */
export function PhoneTopBar(props: PhoneTopBarProps) {
  const { onToggleDrawer, onOpenPalette } = props;

  const activeWorkspaceKey = useAppStore(selectActiveWorkspaceKey);
  // Truncation is CSS's job, not this component's, so a long name degrades
  // gracefully in whatever width the phone gives it.
  const workspaceName = useProjectStore((s) =>
    workspaceDisplayName(activeWorkspaceKey, s.projects),
  );
  // Tasks is a surface over the workspace, not a workspace of its own.
  const onTasks = useAppStore((s) => s.activeSurface === "tasks");
  const macChrome = isElectronMacOS();

  return (
    <div
      className={styles.topBar}
      data-testid="phone-top-bar"
      data-mac-inset={macChrome ? "true" : undefined}
    >
      <Button
        variant="ghost"
        className={styles.iconButton}
        aria-label="Open sidebar"
        data-testid="phone-drawer-toggle"
        onClick={onToggleDrawer}
      >
        <PanelLeft size={18} />
      </Button>
      <div className={styles.workspaceName}>{onTasks ? "Tasks" : workspaceName}</div>
      <div className={styles.actions}>
        <Button
          variant="ghost"
          className={styles.iconButton}
          aria-label="Open command palette"
          data-testid="phone-palette-button"
          onClick={onOpenPalette}
        >
          <Search size={18} />
        </Button>
      </div>
    </div>
  );
}
