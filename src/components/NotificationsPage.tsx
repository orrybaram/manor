import { Switch } from "./Switch";
import styles from "./SettingsModal.module.css";
import { usePreferencesStore } from "../store/preferences-store";

const isMac =
  navigator.platform.includes("Mac") || navigator.userAgent.includes("Mac");

export function NotificationsPage() {
  const { preferences, set } = usePreferencesStore();

  return (
    <div className={styles.pageContent}>
      <div className={styles.notifToggleCard}>
        <div>
          <div className={styles.notifToggleTitle}>
            Enable Desktop Notifications
          </div>
          <div className={styles.notifToggleDesc}>
            Receive native desktop notifications for agent activity. You can
            customize which events trigger notifications below.
          </div>
        </div>
        <Switch
          checked={preferences.notifyOnResponse || preferences.notifyOnRequiresInput}
          onCheckedChange={(checked) => {
            set("notifyOnResponse", checked);
            set("notifyOnRequiresInput", checked);
          }}
        />
      </div>

      <div className={styles.settingsGroup}>
        <div className={styles.sectionTitle}>Notify me when...</div>

        <label className={styles.notifRow}>
          <span>Agent responds</span>
          <Switch
            checked={preferences.notifyOnResponse}
            onCheckedChange={(checked) => set("notifyOnResponse", checked)}
          />
        </label>

        <label className={styles.notifRow}>
          <span>Agent needs input</span>
          <Switch
            checked={preferences.notifyOnRequiresInput}
            onCheckedChange={(checked) =>
              set("notifyOnRequiresInput", checked)
            }
          />
        </label>

        <label className={styles.notifRow}>
          <span>Play notification sound</span>
          <Switch
            checked={preferences.notificationSound}
            onCheckedChange={(checked) => set("notificationSound", checked)}
          />
        </label>

        {isMac && (
          <label className={styles.notifRow}>
            <span>Show dock badge for agent responses</span>
            <Switch
              checked={preferences.dockBadgeEnabled}
              onCheckedChange={(checked) => set("dockBadgeEnabled", checked)}
            />
          </label>
        )}
      </div>
    </div>
  );
}
