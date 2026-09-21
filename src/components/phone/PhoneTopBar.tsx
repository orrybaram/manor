import PanelLeft from "lucide-react/dist/esm/icons/panel-left";
import Search from "lucide-react/dist/esm/icons/search";
import SquareStack from "lucide-react/dist/esm/icons/square-stack";
import { Button } from "../ui/Button/Button";
import styles from "./Phone.module.css";

type PhoneTopBarProps = {
  /** The active workspace's display name ("Home", or a project workspace's
   *  name/branch). Truncation is CSS's job, not this component's, so a long
   *  name degrades gracefully in whatever width the phone gives it. */
  workspaceName: string;
  /** Opens/closes the sidebar drawer. Ticket 4 renders what this opens. */
  onToggleDrawer: () => void;
  /** Opens the pane-switcher sheet. Ticket 5 renders what this opens. */
  onOpenPaneSwitcher: () => void;
  /** Opens the command palette full screen. Ticket 6 styles it for phone
   *  width; this button only opens the same `CommandPalette` the desk
   *  layout already has. */
  onOpenPalette: () => void;
};

/**
 * ADR-181 D3: the phone shell's top bar — a drawer toggle, the active
 * workspace's name, and the two surfaces a phone reaches everything else
 * through (the pane switcher and the command palette). Rendered once, in
 * `App.tsx`, around the workspace stack — never inside a split component,
 * so it cannot affect a terminal's geometry, and switching panes remounts
 * nothing here either.
 */
export function PhoneTopBar(props: PhoneTopBarProps) {
  const { workspaceName, onToggleDrawer, onOpenPaneSwitcher, onOpenPalette } = props;

  return (
    <div className={styles.topBar} data-testid="phone-top-bar">
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
