import PanelLeft from "lucide-react/dist/esm/icons/panel-left";
import Search from "lucide-react/dist/esm/icons/search";
import SquareStack from "lucide-react/dist/esm/icons/square-stack";
import { Button } from "../ui/Button/Button";
import { isWebApp } from "../../lib/platform";
import { workspaceDisplayName } from "../../lib/workspace-display-name";
import { useAppStore } from "../../store/app-store";
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
  /** Opens the pane-switcher sheet. */
  onOpenPaneSwitcher: () => void;
  /** Opens the command palette — the same `CommandPalette` the desk layout
   *  has, full screen at phone width. */
  onOpenPalette: () => void;
};

/**
 * ADR-181 D3: the phone shell's top bar — a drawer toggle, the active
 * workspace's name, and the two surfaces a phone reaches everything else
 * through (the pane switcher and the command palette). Rendered once, by
 * `PhoneChrome`, around the workspace stack — never inside a split
 * component, so it cannot affect a terminal's geometry, and switching panes
 * remounts nothing here either.
 */
export function PhoneTopBar(props: PhoneTopBarProps) {
  const { onToggleDrawer, onOpenPaneSwitcher, onOpenPalette } = props;

  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  // Truncation is CSS's job, not this component's, so a long name degrades
  // gracefully in whatever width the phone gives it.
  const workspaceName = useProjectStore((s) =>
    workspaceDisplayName(activeWorkspacePath, s.projects),
  );
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
      <div className={styles.workspaceName}>{workspaceName}</div>
      <div className={styles.actions}>
        <Button
          variant="ghost"
          className={styles.iconButton}
          aria-label="Switch pane"
          data-testid="phone-pane-switcher-button"
          onClick={onOpenPaneSwitcher}
        >
          <SquareStack size={18} />
        </Button>
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
