import { ThemeSection } from "./ThemeSection";
import { Switch } from "./Switch";
import styles from "./SettingsModal.module.css";
import { usePreferencesStore } from "../store/preferences-store";

const isMac = navigator.platform.includes("Mac") || navigator.userAgent.includes("Mac");

export function AppSettingsPage() {
  const { preferences, set } = usePreferencesStore();

  return (
    <div className={styles.pageContent}>
      <ThemeSection />

      <div className={styles.settingsGroup}>
        <div className={styles.sectionTitle}>Notifications</div>
        {isMac && (
          <label className={styles.toggleRow}>
            <Switch
              checked={preferences.dockBadgeEnabled}
              onCheckedChange={(checked) => set("dockBadgeEnabled", checked)}
            />
            <span>Show dock badge for agent responses</span>
          </label>
        )}
        <label className={styles.toggleRow}>
          <Switch
            checked={preferences.notifyOnResponse}
            onCheckedChange={(checked) => set("notifyOnResponse", checked)}
          />
          <span>Notify when agent responds</span>
        </label>
        <label className={styles.toggleRow}>
          <Switch
            checked={preferences.notifyOnRequiresInput}
            onCheckedChange={(checked) => set("notifyOnRequiresInput", checked)}
          />
          <span>Notify when agent needs input</span>
        </label>
        <label className={styles.toggleRow}>
          <Switch
            checked={preferences.notificationSound}
            onCheckedChange={(checked) => set("notificationSound", checked)}
          />
          <span>Play notification sound</span>
        </label>
      </div>

      <div className={styles.settingsGroup}>
        <div className={styles.sectionTitle}>Font</div>
        <div className={styles.placeholder}>
          Font family and size settings coming soon.
        </div>
      </div>

      <div className={styles.settingsGroup}>
        <div className={styles.sectionTitle}>Keybindings</div>
        <div className={styles.placeholder}>
          Custom keyboard shortcuts coming soon.
        </div>
      </div>
    </div>
  );
}
