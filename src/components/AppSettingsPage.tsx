import { ThemeSection } from "./ThemeSection";
import styles from "./SettingsModal.module.css";
import { usePreferencesStore } from "../store/preferences-store";

const isMac = navigator.platform.includes("Mac") || navigator.userAgent.includes("Mac");

export function AppSettingsPage() {
  const { preferences, set } = usePreferencesStore();

  return (
    <div className={styles.pageContent}>
      <ThemeSection />

      {isMac && (
        <div className={styles.settingsGroup}>
          <div className={styles.sectionTitle}>Notifications</div>
          <label className={styles.toggleRow}>
            <input
              type="checkbox"
              checked={preferences.dockBadgeEnabled}
              onChange={(e) => set("dockBadgeEnabled", e.target.checked)}
            />
            <span>Show dock badge for agent responses</span>
          </label>
        </div>
      )}

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
