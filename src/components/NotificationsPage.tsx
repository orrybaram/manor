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
          checked={
            preferences.notifyOnResponse || preferences.notifyOnRequiresInput
          }
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
            onCheckedChange={(checked) => set("notifyOnRequiresInput", checked)}
          />
        </label>

        <div className={styles.notifRow}>
          <span>Notification sound</span>
          <select
            className={styles.soundSelect}
            value={
              preferences.notificationSound === false
                ? "none"
                : preferences.notificationSound
            }
            onChange={(e) => {
              const val = e.target.value;
              if (val !== "none") {
                window.electronAPI.preferences.playSound(val);
              }
              set("notificationSound", val === "none" ? false : val);
            }}
          >
            <option value="none">None</option>
            <option value="Basso">Basso</option>
            <option value="Blow">Blow</option>
            <option value="Bottle">Bottle</option>
            <option value="Frog">Frog</option>
            <option value="Funk">Funk</option>
            <option value="Glass">Glass</option>
            <option value="Hero">Hero</option>
            <option value="Morse">Morse</option>
            <option value="Ping">Ping</option>
            <option value="Pop">Pop</option>
            <option value="Purr">Purr</option>
            <option value="Sosumi">Sosumi</option>
            <option value="Submarine">Submarine</option>
            <option value="Tink">Tink</option>
          </select>
        </div>

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
