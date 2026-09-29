import { NotificationsPopover } from "../../notifications/NotificationsPopover";
import styles from "./WindowTrail.module.css";

/**
 * The window's top-right controls (ADR-196), mirroring the WindowLead: the
 * notifications bell, in the same spot whatever the sidebar mode. The
 * top-right panel's tab bar stops short of it via `--window-trail-inset`.
 */
export function WindowTrail() {
  return (
    <div className={styles.trail} data-testid="window-trail">
      <NotificationsPopover />
    </div>
  );
}
